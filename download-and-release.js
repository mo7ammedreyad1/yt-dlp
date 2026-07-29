#!/usr/bin/env node
'use strict';

/**
 * يحمّل فيديو يوتيوب عن طريق Piped API (مش yt-dlp خالص) ويرفعه كـ GitHub Release.
 *
 * ليه Piped؟ الاستخراج بيحصل على سيرفر الـ Piped instance نفسه، مش على
 * IP بتاع GitHub Actions، فمش بتقابل مشكلة "Sign in to confirm you're not a bot".
 *
 * متغيرات البيئة:
 *   VIDEO_URL         - رابط فيديو اليوتيوب (مطلوب)
 *   GITHUB_TOKEN       - توكن GitHub (secrets.GITHUB_TOKEN كافي)
 *   GITHUB_REPOSITORY  - متاح تلقائيًا جوه GitHub Actions (owner/repo)
 *   PIPED_INSTANCES    - اختياري: قايمة instances مفصولة بفاصلة لتجربتها
 *                        بدل القايمة الافتراضية اللي في الكود
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { Octokit } = require('@octokit/rest');

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

// قايمة الـ instances الافتراضية - من التوثيق الرسمي لمشروع Piped:
// https://github.com/TeamPiped/documentation/blob/main/content/docs/public-instances/index.md
// لو حبيت تحدّثها أو تضيف/تشيل instance، بص على الرابط ده أو https://status.piped.video
const DEFAULT_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space',
];

function getInstances() {
  const fromEnv = process.env.PIPED_INSTANCES;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_INSTANCES;
}

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getStreamsInfo(videoId) {
  const instances = getInstances();
  const errors = [];

  for (const instance of instances) {
    const apiUrl = `${instance.replace(/\/$/, '')}/streams/${videoId}`;
    try {
      console.log(`🔎 بتجرب instance: ${instance}`);
      const res = await fetchWithTimeout(apiUrl, 15000);
      if (!res.ok) {
        errors.push(`${instance}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (!data || (!data.videoStreams?.length && !data.audioStreams?.length)) {
        errors.push(`${instance}: الرد مفهوش streams`);
        continue;
      }
      console.log(`✅ نجح مع: ${instance}`);
      return data;
    } catch (err) {
      errors.push(`${instance}: ${err.message}`);
    }
  }

  fail(`كل الـ Piped instances فشلت معايا:\n${errors.join('\n')}`);
}

function extensionFromMime(mimeType) {
  if (!mimeType) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('3gpp')) return '3gp';
  return 'mp4';
}

function pickBestStreams(data) {
  const videoStreams = data.videoStreams || [];
  const audioStreams = data.audioStreams || [];

  // أفضل حالة: stream فيه فيديو + صوت مدموجين (progressive) - مش محتاجين ffmpeg خالص
  const progressive = videoStreams
    .filter((s) => s.videoOnly === false)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (progressive.length > 0) {
    return { type: 'progressive', video: progressive[0] };
  }

  // مفيش نسخة مدموجة: ناخد أفضل فيديو (من غير صوت) + أفضل صوت لوحده وندمجهم بـ ffmpeg
  const bestVideo = [...videoStreams].sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  const bestAudio = [...audioStreams].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

  if (!bestVideo || !bestAudio) {
    fail('مقدرتش ألاقي streams صالحة لتحميل الفيديو ده');
  }

  return { type: 'separate', video: bestVideo, audio: bestAudio };
}

function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

async function downloadToFile(url, destPath) {
  const res = await fetchWithTimeout(url, 120000);
  if (!res.ok || !res.body) {
    fail(`فشل تحميل الملف (HTTP ${res.status}): ${url}`);
  }
  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destPath);
    Readable.fromWeb(res.body).pipe(fileStream);
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });
}

async function main() {
  const videoUrl = process.env.VIDEO_URL;
  const token = process.env.GITHUB_TOKEN;
  const repoFull = process.env.GITHUB_REPOSITORY;

  if (!videoUrl) fail('لازم تحدد رابط الفيديو عن طريق متغير البيئة VIDEO_URL');
  if (!token) fail('GITHUB_TOKEN مش موجود في متغيرات البيئة');
  if (!repoFull || !repoFull.includes('/')) fail('GITHUB_REPOSITORY مش موجود أو غلط');

  const [owner, repo] = repoFull.split('/');
  const workDir = process.cwd();

  const videoId = extractVideoId(videoUrl);
  if (!videoId) fail('مقدرتش أستخرج video ID من الرابط ده - اتأكد إنه رابط يوتيوب صحيح');

  console.log(`⬇️  بدء تحميل الفيديو: ${videoUrl} (ID: ${videoId})`);

  const data = await getStreamsInfo(videoId);
  const title = sanitizeFilename(data.title || videoId);
  const picked = pickBestStreams(data);

  let finalPath;

  if (picked.type === 'progressive') {
    const ext = extensionFromMime(picked.video.mimeType);
    finalPath = path.join(workDir, `${title}.${ext}`);
    console.log(`⬇️  تحميل نسخة مدموجة (فيديو+صوت) - جودة ${picked.video.quality}`);
    await downloadToFile(picked.video.url, finalPath);
  } else {
    const videoExt = extensionFromMime(picked.video.mimeType);
    const audioExt = extensionFromMime(picked.audio.mimeType);
    const videoTmp = path.join(workDir, `_video_tmp.${videoExt}`);
    const audioTmp = path.join(workDir, `_audio_tmp.${audioExt}`);

    console.log(`⬇️  تحميل الفيديو (${picked.video.quality}) والصوت (${picked.audio.quality}) منفصلين`);
    await downloadToFile(picked.video.url, videoTmp);
    await downloadToFile(picked.audio.url, audioTmp);

    finalPath = path.join(workDir, `${title}.${videoExt}`);
    console.log('🔧 بيتم دمج الفيديو والصوت باستخدام ffmpeg...');
    execFileSync('ffmpeg', ['-y', '-i', videoTmp, '-i', audioTmp, '-c', 'copy', finalPath]);

    fs.unlinkSync(videoTmp);
    fs.unlinkSync(audioTmp);
  }

  const fileSize = fs.statSync(finalPath).size;
  const fileName = path.basename(finalPath);
  console.log(`✅ اتحمل: ${fileName} (${(fileSize / (1024 * 1024)).toFixed(1)} MB)`);

  const octokit = new Octokit({ auth: token });
  const tagName = `video-${Date.now()}`;

  console.log(`📦 بيتعمل Release جديد بالتاج: ${tagName}`);
  const release = await octokit.rest.repos.createRelease({
    owner,
    repo,
    tag_name: tagName,
    name: title,
    body: `تم التحميل تلقائيًا عن طريق Piped API من الرابط:\n${videoUrl}`,
  });

  console.log('⬆️  بيتم رفع الفيديو كـ asset في الـ Release...');
  const fileData = fs.readFileSync(finalPath);
  await octokit.rest.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: release.data.id,
    name: fileName,
    data: fileData,
    headers: {
      'content-type': 'video/mp4',
      'content-length': fileSize,
    },
  });

  console.log(`🎉 تم بنجاح! رابط الـ Release: ${release.data.html_url}`);
}

main().catch((err) => {
  fail(err.stack || err.message);
});
