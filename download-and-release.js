#!/usr/bin/env node
'use strict';

/**
 * يقرأ رابط فيديو يوتيوب من متغير البيئة VIDEO_URL،
 * يحمّله باستخدام yt-dlp (لازم يكون متثبت مسبقًا في الـ runner)،
 * وبعدين ينشئ GitHub Release ويرفع الفيديو كـ asset فيه.
 *
 * متغيرات البيئة المطلوبة:
 *   VIDEO_URL         - رابط فيديو اليوتيوب
 *   GITHUB_TOKEN       - توكن للتعامل مع GitHub API (secrets.GITHUB_TOKEN كافي)
 *   GITHUB_REPOSITORY  - متاح تلقائيًا جوه GitHub Actions (owner/repo)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
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

  console.log(`⬇️  بدء تحميل الفيديو من: ${videoUrl}`);

  // --print after_move:filepath بيطبع المسار النهائي للملف بعد ما التحميل
  // والدمج (merge) يخلصوا خالص، وده أدق طريقة نعرف بيها اسم الملف الناتج.
  const ytDlpArgs = [
    '--quiet',
    '--no-warnings',
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '--restrict-filenames',
    '-o', '%(title).150B [%(id)s].%(ext)s',
    '--print', 'after_move:filepath',
  ];

  // محاولة player_client مختلفة (بدل الكوكيز) — بعض الـ clients (زي web/tv)
  // أحيانًا بتتفادى فحص البوت لفترة قبل ما يوتيوب يحدّث الحظر عليها كمان.
  // ده تجربة رخيصة ومش مضمونة 100%، قابلة للتعديل من الـ workflow من غير
  // ما تلمس الكود تاني عن طريق متغير YTDLP_PLAYER_CLIENT.
  const playerClient = process.env.YTDLP_PLAYER_CLIENT || 'default,tv,web_safari';
  ytDlpArgs.push('--extractor-args', `youtube:player_client=${playerClient}`);
  console.log(`🎭 هيتم تجربة player_client: ${playerClient}`);

  // IP بتاع GitHub Actions runners مصنف عند يوتيوب كـ"داتا سنتر" وغالبًا
  // بيدي "Sign in to confirm you're not a bot" من غير كوكيز حقيقية.
  // لو ملف cookies.txt موجود (اتحط في خطوة سابقة في الـ workflow) بنستخدمه.
  const cookiesPath = path.join(workDir, 'cookies.txt');
  if (fs.existsSync(cookiesPath)) {
    console.log('🍪 هيتم استخدام كوكيز يوتيوب المحفوظة');
    ytDlpArgs.push('--cookies', cookiesPath);
  } else {
    console.log('⚠️  مفيش كوكيز محفوظة — لو الـ player_client مانفعش، ده هيبقى الحل الأكيد الجاي');
  }

  ytDlpArgs.push(videoUrl);

  let filePath;
  try {
    // execFileSync (مش exec/execSync) عشان الرابط بييجي من مدخلات المستخدم
    // ومش عايزين نمرره جوه shell string لتفادي أي مشاكل حقن أوامر.
    const output = execFileSync('yt-dlp', ytDlpArgs, {
      cwd: workDir,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 50,
    });
    const lines = output.trim().split('\n').filter(Boolean);
    filePath = lines[lines.length - 1];
  } catch (err) {
    fail(`فشل تحميل الفيديو عن طريق yt-dlp: ${err.message}`);
  }

  if (!filePath || !fs.existsSync(filePath)) {
    fail('التحميل خلص بس مقدرتش ألاقي الملف الناتج على القرص');
  }

  const fullPath = path.resolve(workDir, filePath);
  const fileName = path.basename(fullPath);
  const fileSize = fs.statSync(fullPath).size;

  console.log(`✅ اتحمل: ${fileName} (${(fileSize / (1024 * 1024)).toFixed(1)} MB)`);

  const octokit = new Octokit({ auth: token });
  const tagName = `video-${Date.now()}`;

  console.log(`📦 بيتعمل Release جديد بالتاج: ${tagName}`);

  const release = await octokit.rest.repos.createRelease({
    owner,
    repo,
    tag_name: tagName,
    name: fileName.replace(/\.[^/.]+$/, ''),
    body: `تم التحميل تلقائيًا عن طريق GitHub Actions من الرابط:\n${videoUrl}`,
  });

  console.log('⬆️  بيتم رفع الفيديو كـ asset في الـ Release...');

  const fileData = fs.readFileSync(fullPath);

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
