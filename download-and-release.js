#!/usr/bin/env node
'use strict';

/**
 * يقرأ رابط الفيديو من متغير البيئة VIDEO_URL،
 * يحمّله عبر Cobalt API،
 * ينشئ GitHub Release ويرفع الفيديو كـ asset فيه.
 */

const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

// دالة مساعدة لتنزيل الملف وحفظه على القرص
async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`فشل تنزيل ملف الفيديو: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(outputPath, buffer);
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

  console.log(`⬇️  جاري طلب رابط التحميل المباشر من Cobalt API لـ: ${videoUrl}`);

  // 1. طلب رابط التحميل من Cobalt API
  const cobaltRes = await fetch('https://api.cobalt.tools/api/json', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    },
    body: JSON.stringify({
      url: videoUrl,
      videoQuality: 'max', // أعلى جودة مجهزة (1080p, 4k, إلخ)
      filenamePattern: 'basic'
    })
  });

  if (!cobaltRes.ok) {
    fail(`فشل التواصل مع Cobalt API: ${cobaltRes.status} ${cobaltRes.statusText}`);
  }

  const cobaltData = await cobaltRes.json();

  if (cobaltData.status === 'error') {
    fail(`خطأ من Cobalt: ${cobaltData.text || 'تعذر معالجة الرابط'}`);
  }

  const downloadUrl = cobaltData.url;
  const fileName = cobaltData.filename || `video-${Date.now()}.mp4`;
  const fullPath = path.resolve(workDir, fileName);

  if (!downloadUrl) {
    fail('لم يتم إرجاع رابط تحميل مباشر من الخدمة.');
  }

  console.log(`⬇️  بدء تنزيل الفيديو...`);
  await downloadFile(downloadUrl, fullPath);

  const fileSize = fs.statSync(fullPath).size;
  console.log(`✅ اتحمل بنجاح: ${fileName} (${(fileSize / (1024 * 1024)).toFixed(1)} MB)`);

  // 2. إنشاء GitHub Release ورفع الملف
  const octokit = new Octokit({ auth: token });
  const tagName = `video-${Date.now()}`;

  console.log(`📦 بيتعمل Release جديد بالتاج: ${tagName}`);

  const release = await octokit.rest.repos.createRelease({
    owner,
    repo,
    tag_name: tagName,
    name: fileName.replace(/\.[^/.]+$/, ''),
    body: `تم التحميل تلقائيًا عن طريق GitHub Actions و Cobalt API من الرابط:\n${videoUrl}`,
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

