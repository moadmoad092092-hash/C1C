const form = document.getElementById('convertForm');
const nameInput = document.getElementById('appName');
const urlInput = document.getElementById('siteUrl');
const button = document.getElementById('convertBtn');
const progressBar = document.getElementById('progressBar');
const percent = document.getElementById('percent');
const statusText = document.getElementById('statusText');
const timeText = document.getElementById('timeText');
const downloadLink = document.getElementById('downloadLink');
const API_BASE = String(window.SITE_TO_APP_API_BASE || '').replace(/\/+$/, '');
let pollTimer;

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function showStatus(job) {
  const value = Number.isFinite(job.percent) ? job.percent : null;
  progressBar.style.width = value === null ? '0%' : `${value}%`;
  percent.textContent = value === null ? '—' : `${value}%`;
  statusText.textContent = job.error || job.message || 'جارٍ البناء...';
  timeText.textContent = job.elapsedSeconds ? `الوقت المنقضي: ${job.elapsedSeconds} ثانية${job.remainingSeconds ? ` • المتبقي تقريبًا: ${job.remainingSeconds} ثانية` : ''}` : '';
  if (job.state === 'success' && job.downloadUrl) {
    downloadLink.href = /^https?:\/\//i.test(job.downloadUrl) ? job.downloadUrl : apiUrl(job.downloadUrl);
    downloadLink.hidden = false;
  } else {
    downloadLink.hidden = true;
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    if (/^\s*<!doctype html|^\s*<html/i.test(text)) {
      throw new Error('عنوان خادم البناء غير صحيح: استضاف GitHub Pages صفحة HTML بدل استجابة JSON. اضبط config.js على عنوان خادم Node.js فعلي.');
    }
    throw new Error('استجابة خادم البناء غير صالحة.');
  }
}

async function pollJob(id) {
  try {
    const response = await fetch(apiUrl(`/api/build/${encodeURIComponent(id)}`), { cache: 'no-store' });
    const job = await readJson(response);
    if (!response.ok) throw new Error(job.error || 'تعذر قراءة حالة البناء من الخادم.');
    showStatus(job);
    if (job.state === 'queued' || job.state === 'building') {
      pollTimer = window.setTimeout(() => pollJob(id), 1000);
      return;
    }
    button.disabled = false;
    button.textContent = 'تحويل';
  } catch (error) {
    showStatus({ percent: null, message: error.message });
    button.disabled = false;
    button.textContent = 'تحويل';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  window.clearTimeout(pollTimer);
  downloadLink.hidden = true;
  const appName = nameInput.value.trim();
  const siteUrl = urlInput.value.trim();
  if (!appName || !siteUrl) {
    showStatus({ percent: null, message: 'أدخل اسم التطبيق ورابط الموقع أولاً.' });
    return;
  }
  try {
    const parsed = new URL(siteUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    showStatus({ percent: null, message: 'الرابط غير صحيح. استخدم رابطًا يبدأ بـ https:// أو http://' });
    urlInput.focus();
    return;
  }
  if (!API_BASE && /(^|\.)github\.io$/i.test(window.location.hostname)) {
    showStatus({ percent: null, message: 'لم يتم ربط خادم بناء APK بالموقع المنشور. استضافة GitHub Pages ثابتة ولا تشغّل Node.js أو Gradle. اضبط عنوان الخادم في config.js.' });
    return;
  }
  button.disabled = true;
  button.textContent = 'جارٍ البناء...';
  showStatus({ percent: 0, message: 'جارٍ إرسال طلب بناء APK حقيقي...' });
  try {
    const response = await fetch(apiUrl('/api/build'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName, siteUrl })
    });
    const job = await readJson(response);
    if (!response.ok) throw new Error(job.error || 'تعذر بدء البناء.');
    showStatus(job);
    pollJob(job.id);
  } catch (error) {
    showStatus({ percent: null, message: error.name === 'TypeError' ? 'تعذر الاتصال بخادم البناء. تحقق من عنوانه ومن إعداد CORS.' : error.message });
    button.disabled = false;
    button.textContent = 'تحويل';
  }
});
