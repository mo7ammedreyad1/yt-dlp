#!/usr/bin/env node
'use strict';

/**
 * بيشغل متصفح Chromium حقيقي (Playwright) جوه الـ Action، يفتح صفحة الفيديو
 * زي أي إنسان عادي، وبيلقط روابط الفيديو/الصوت المباشرة (googlevideo.com)
 * من الطلبات اللي المتصفح نفسه بيبعتها بعد ما يعدي فحص البوت طبيعي.
 *
 * ده مختلف جوهريًا عن كل المحاولات اللي قبل كده: مفيش أي "تقليد" لمتصفح -
 * المتصفح ده حقيقي فعلًا وبيحل تحدي BotGuard بنفسه زي أي متصفح عادي.
 *
 * تحذير أمانة: ده تجريبي ومش مضمون - لو الـ IP نفسه محظور بشكل عام،
 * حتى المتصفح الحقيقي ممكن ياخد نفس رسالة "Sign in to confirm you're not a bot".
 *
 * متغيرات البيئة:
 *   VIDEO_URL, GITHUB_TOKEN, GITHUB_REPOSITORY - زي كل مرة
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { chromium } = require('playwright');
const { Octokit } = require('@octokit/rest');

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// أشهر itags بتاعة يوتيوب - مش شامل كل الاحتمالات لكن بيغطي الغالبية العظمى
const ITAG_INFO = {
  18: { kind: 'progressive', quality: 360, container: 'mp4' },
  22: { kind: 'progressive', quality: 720, container: 'mp4' },
  137: { kind: 'video', quality: 1080, container: 'mp4' },
  136: { kind: 'video', quality: 720, container: 'mp4' },
  135: { kind: 'video', quality: 480, container: 'mp4' },
  134: { kind: 'video', quality: 360, container: 'mp4' },
  133: { kind: 'video', quality: 240, container: 'mp4' },
  160: { kind: 'video', quality: 144, container: 'mp4' },
  248: { kind: 'video', quality: 1080, container: 'webm' },
  247: { kind: 'video', quality: 720, container: 'webm' },
  244: { kind: 'video', quality: 480, container: 'webm' },
  243: { kind: 'video', quality: 360, container: 'webm' },
  242: { kind: 'video', quality: 240, container: 'webm' },
  140: { kind: 'audio', quality: 128, container: 'mp4' },
  139: { kind: 'audio', quality: 48, container: 'mp4' },
  251: { kind: 'audio', quality: 160, container: 'webm' },
  250: { kind: 'audio', quality: 70, container: 'webm' },
  249: { kind: 'audio', quality: 50, container: 'webm' },
};

function pickBestStreams(streams) {
  const withInfo = streams
    .map((s) => ({ ...s, info: ITAG_INFO[Number(s.itag)] }))
    .filter((s) => s.info);

  const progressive = withInfo
    .filter((s) => s.info.kind === 'progressive')
    .sort((a, b) => b.info.quality - a.info.quality);
  if (progressive.length > 0) {
    return { type: 'progressive', stream: progressive[0] };
  }

  const videos = withInfo
    .filter((s) => s.info.kind === 'video')
    .sort((a, b) => b.info.quality - a.info.quality);
  const audios = withInfo
    .filter((s) => s.info.kind === 'audio')
    .sort((a, b) => b.info.quality - a.info.quality);

  if (videos.length === 0 || audios.length === 0) return null;
  return { type: 'separate', video: videos[0], audio: audios[0] };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadToFile(url, destPath, headers) {
  const res = await fetchWithTimeout(url, { headers }, 180000);
  if (!res.ok || !res.body) {
    fail(`فشل تحميل ملف الميديا (HTTP ${res.status}) من الرابط اللي اتلقط`);
  }
  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destPath);
    Readable.fromWeb(res.body).pipe(fileStream);
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });
}

async function captureStreamUrls(videoUrl) {
  console.log('🌐 بيتم تشغيل Chromium حقيقي (headless) عشان يعدي فحص البوت زي متصفح عادي...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  const capturedUrls = new Map(); // itag -> { url, itag, mime }

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('googlevideo.com') && url.includes('videoplayback')) {
      try {
        const u = new URL(url);
        const itag = u.searchParams.get('itag');
        const mime = decodeURIComponent(u.searchParams.get('mime') || '');
        if (itag && !capturedUrls.has(itag)) {
          capturedUrls.set(itag, { url, itag, mime });
          console.log(`  📡 اتلقط stream - itag ${itag} (${mime})`);
        }
      } catch {
        // تجاهل أي رابط مش قادرين نحلله
      }
    }
  });

  try {
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // محاولة قفل نوافذ موافقة الكوكيز الشائعة لو ظهرت
    for (const text of ['Accept all', 'I agree', 'موافق']) {
      try {
        await page.click(`button:has-text("${text}")`, { timeout: 2000 });
      } catch {
        /* مفيش نافذة زي دي - عادي */
      }
    }

    // تشغيل الفيديو يدويًا (autoplay غالبًا محتاج mute الأول)
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.muted = true;
        v.play().catch(() => {});
      }
    });

    // ننتظر عشان الـ player يبدأ فعليًا يجيب الـ streams
    await page.waitForTimeout(9000);

    const hasVideoTag = await page.evaluate(() => !!document.querySelector('video'));
    const title = (await page.title()).replace(/ - YouTube$/, '');

    if (capturedUrls.size === 0) {
      const snippet = (await page.evaluate(() => document.body?.innerText?.slice(0, 300))) || '';
      console.log(`ℹ️  عنوان الصفحة: ${title}`);
      console.log(`ℹ️  فيه عنصر video في الصفحة؟ ${hasVideoTag}`);
      console.log(`ℹ️  أول 300 حرف من محتوى الصفحة: ${snippet}`);
    }

    return { title, streams: Array.from(capturedUrls.values()) };
  } finally {
    await browser.close();
  }
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

  console.log(`⬇️  بدء تحميل الفيديو: ${videoUrl}`);

  const { title, streams } = await captureStreamUrls(videoUrl);

  if (streams.length === 0) {
    fail(
      'المتصفح فتح الصفحة بس مقدرش يلقط أي stream فعلي - غالبًا فحص البوت رفض حتى المتصفح ده (شوف اللوج فوق لتفاصيل أكتر)'
    );
  }

  const picked = pickBestStreams(streams);
  if (!picked) {
    const itags = streams.map((s) => s.itag).join(', ');
    fail(`اتلقطت streams بس بـ itags مش معروفة عندنا (${itags}) - محتاجين نضيفهم للقايمة في الكود`);
  }

  const sanitizedTitle = sanitizeFilename(title || 'video');
  const refererHeaders = { Referer: 'https://www.youtube.com/', 'User-Agent': UA };

  let finalPath;

  if (picked.type === 'progressive') {
    finalPath = path.join(workDir, `${sanitizedTitle}.${picked.stream.info.container}`);
    console.log(`⬇️  تحميل نسخة مدموجة - جودة ${picked.stream.info.quality}p`);
    await downloadToFile(picked.stream.url, finalPath, refererHeaders);
  } else {
    const videoTmp = path.join(workDir, `_video_tmp.${picked.video.info.container}`);
    const audioTmp = path.join(workDir, `_audio_tmp.${picked.audio.info.container}`);

    console.log(
      `⬇️  تحميل الفيديو (${picked.video.info.quality}p) والصوت (${picked.audio.info.quality}kbps) منفصلين`
    );
    await downloadToFile(picked.video.url, videoTmp, refererHeaders);
    await downloadToFile(picked.audio.url, audioTmp, refererHeaders);

    // mkv بيقبل أي تركيبة كودك (h264/vp9 مع aac/opus) من غير مشاكل توافق حاوية
    finalPath = path.join(workDir, `${sanitizedTitle}.mkv`);
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
    name: sanitizedTitle,
    body: `تم التحميل تلقائيًا عن طريق متصفح حقيقي (Playwright) من الرابط:\n${videoUrl}`,
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
