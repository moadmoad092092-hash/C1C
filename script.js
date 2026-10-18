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
let activeDownloadUrl = '';

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function showStatus(job) {
  const value = Number.isFinite(job.percent) ? job.percent : null;
  progressBar.style.width = value === null ? '0%' : `${value}%`;
  percent.textContent = value === null ? '—' : `${value}%`;
  statusText.textContent = job.error || job.message || 'جارٍ البناء...';
  timeText.textContent = job.elapsedSeconds
    ? `الوقت المنقضي: ${job.elapsedSeconds} ثانية${job.remainingSeconds ? ` • المتبقي تقريبًا: ${job.remainingSeconds} ثانية` : ''}`
    : '';
}

function clearDownload() {
  downloadLink.hidden = true;
  downloadLink.removeAttribute('download');
  if (activeDownloadUrl) URL.revokeObjectURL(activeDownloadUrl);
  activeDownloadUrl = '';
}

function offerApk(fileName, contentBase64) {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  activeDownloadUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.android.package-archive' }));
  downloadLink.href = activeDownloadUrl;
  downloadLink.download = fileName || 'app.apk';
  downloadLink.hidden = false;
}

function parseSseBlock(block) {
  const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
  return data ? JSON.parse(data) : null;
}

async function consumeBuildStream(response) {
  if (!response.ok) {
    const text = await response.text();
    try { throw new Error(JSON.parse(text).error || 'تعذر بدء البناء.'); }
    catch (error) { throw error instanceof SyntaxError ? new Error('استجابة خادم البناء غير صالحة.') : error; }
  }
  if (!response.body) throw new Error('المتصفح لا يدعم متابعة بناء APK المباشر.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedApk = false;
  let completed = false;

  const handle = payload => {
    if (!payload) return;
    if (payload.type === 'status') {
      showStatus(payload.job);
      return;
    }
    if (payload.type === 'apk') {
      offerApk(payload.fileName, payload.contentBase64);
      receivedApk = true;
      return;
    }
    if (payload.type === 'error') {
      showStatus(payload.job);
      throw new Error(payload.job?.error || 'فشل بناء APK.');
    }
    if (payload.type === 'complete') completed = true;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let separator;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      if (!block.startsWith(':')) handle(parseSseBlock(block));
    }
    if (done) break;
  }
  if (!completed || !receivedApk) throw new Error('انتهى اتصال البناء قبل استلام ملف APK.');
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearDownload();
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
    showStatus({ percent: null, message: 'لم يتم ربط خادم بناء APK بالموقع المنشور.' });
    return;
  }

  button.disabled = true;
  button.textContent = 'جارٍ البناء...';
  showStatus({ percent: 0, message: 'جارٍ إرسال طلب بناء APK حقيقي...' });
  try {
    const response = await fetch(apiUrl('/api/build'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName, siteUrl })
    });
    await consumeBuildStream(response);
    showStatus({ percent: 100, message: 'تم إنشاء APK والتحقق من الملف بنجاح.', elapsedSeconds: 1 });
  } catch (error) {
    clearDownload();
    showStatus({ percent: null, message: error.name === 'TypeError' ? 'تعذر الاتصال بخادم البناء.' : error.message });
  } finally {
    button.disabled = false;
    button.textContent = 'تحويل';
  }
});
