const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const GRADLE_BIN = process.env.GRADLE_BIN || 'gradle';
const ANDROID_HOME = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
const BUILD_ROOT = path.join(ROOT, 'builds');
const KEYSTORE = path.join(ROOT, 'builder-release.keystore');
const jobs = new Map();
fs.mkdirSync(BUILD_ROOT, { recursive: true });

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}
function safeName(value) {
  return value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
}
function xmlEscape(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 100_000) reject(new Error('الطلب كبير جدًا.')); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('بيانات الطلب غير صحيحة.')); } });
    req.on('error', reject);
  });
}
function publicJob(job) {
  return {
    id: job.id, state: job.state, appName: job.appName,
    percent: job.percent, message: job.message,
    elapsedSeconds: Math.max(0, Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000)),
    remainingSeconds: job.remainingSeconds ?? null,
    downloadUrl: job.downloadUrl || null,
    error: job.error || null
  };
}
function setJob(job, patch) { Object.assign(job, patch); }
function validateInput(body) {
  const appName = safeName(String(body.appName || ''));
  if (!appName) throw new Error('أدخل اسم التطبيق.');
  let siteUrl;
  try { siteUrl = new URL(String(body.siteUrl || '').trim()); }
  catch { throw new Error('الرابط غير صحيح. استخدم رابطًا يبدأ بـ https:// أو http://'); }
  if (!['http:', 'https:'].includes(siteUrl.protocol) || !siteUrl.hostname) throw new Error('الرابط غير صحيح. استخدم رابطًا يبدأ بـ https:// أو http://');
  return { appName, siteUrl: siteUrl.href };
}
function ensureKeystore() {
  if (fs.existsSync(KEYSTORE)) return;
  execFileSync('keytool', ['-genkeypair', '-v', '-keystore', KEYSTORE, '-storepass', 'android', '-keypass', 'android', '-alias', 'androidrelease', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=SiteToApp Builder, OU=Local, O=SiteToApp, L=Local, ST=Local, C=US'], { stdio: 'ignore' });
}
function writeAndroidProject(dir, appName, siteUrl) {
  const files = {
    'settings.gradle': `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name = 'GeneratedWebApp'\ninclude ':app'\n`,
    'build.gradle': `plugins { id 'com.android.application' version '8.5.2' apply false }\n`,
    'gradle.properties': `org.gradle.jvmargs=-Xmx1536m -Dfile.encoding=UTF-8\nandroid.useAndroidX=false\n${process.env.AAPT2_OVERRIDE ? `android.aapt2FromMavenOverride=${process.env.AAPT2_OVERRIDE}\n` : ''}`,
    'app/build.gradle': `plugins { id 'com.android.application' }\n\nandroid { namespace 'com.sitetosapp.generated'; compileSdk 35\n  signingConfigs { release { storeFile file('${KEYSTORE.replace(/\\/g, '/')}'); storePassword 'android'; keyAlias 'androidrelease'; keyPassword 'android' } }\n  defaultConfig { applicationId 'com.sitetosapp.generated'; minSdk 23; targetSdk 35; versionCode 1; versionName '1.0' }\n  buildTypes { release { signingConfig signingConfigs.release; minifyEnabled false } }\n}\n`,
    'app/src/main/AndroidManifest.xml': `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n  <uses-permission android:name="android.permission.INTERNET" />\n  <application android:theme="@style/AppTheme" android:label="@string/app_name" android:icon="@drawable/ic_launcher" android:roundIcon="@drawable/ic_launcher" android:usesCleartextTraffic="true" android:resizeableActivity="true">\n    <activity android:name=".MainActivity" android:exported="true">\n      <intent-filter>\n        <action android:name="android.intent.action.MAIN" />\n        <category android:name="android.intent.category.LAUNCHER" />\n      </intent-filter>\n    </activity>\n  </application>\n</manifest>\n`,
    'app/src/main/res/values/strings.xml': `<?xml version="1.0" encoding="utf-8"?>\n<resources><string name="app_name" translatable="false">${xmlEscape(appName)}</string><string name="site_url" translatable="false">${xmlEscape(siteUrl)}</string></resources>\n`,
    'app/src/main/res/values/styles.xml': `<?xml version="1.0" encoding="utf-8"?>\n<resources><style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar"><item name="android:fontFamily">sans</item><item name="android:colorAccent">#2563EB</item><item name="android:windowLightStatusBar">true</item><item name="android:statusBarColor">#FFFFFF</item></style></resources>\n`,
    'app/src/main/res/drawable/ic_launcher.xml': `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108"><path android:fillColor="#2563EB" android:pathData="M54,4A50,50 0,1 0,54 104A50,50 0,1 0,54 4"/><path android:fillColor="#FFFFFF" android:pathData="M31,54L46,69L78,37L84,43L46,81L25,60Z"/></vector>\n`,
    'app/src/main/java/com/sitetosapp/generated/MainActivity.java': `package com.sitetosapp.generated;\n\nimport android.app.Activity;\nimport android.os.Bundle;\nimport android.webkit.WebResourceRequest;\nimport android.webkit.WebSettings;\nimport android.webkit.WebView;\nimport android.webkit.WebViewClient;\n\npublic class MainActivity extends Activity {\n  private WebView webView;\n  @Override public void onCreate(Bundle state) {\n    super.onCreate(state);\n    webView = new WebView(this);\n    WebSettings settings = webView.getSettings();\n    settings.setJavaScriptEnabled(true);\n    settings.setDomStorageEnabled(true);\n    settings.setBuiltInZoomControls(false);\n    settings.setDisplayZoomControls(false);\n    webView.setWebViewClient(new WebViewClient() {\n      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return false; }\n    });\n    setContentView(webView);\n    webView.loadUrl(getString(com.sitetosapp.generated.R.string.site_url));\n  }\n  @Override public void onBackPressed() {\n    if (webView != null && webView.canGoBack()) webView.goBack();\n    else super.onBackPressed();\n  }\n}\n`
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}
function runBuild(job) {
  const projectDir = path.join(BUILD_ROOT, job.id, 'android');
  const outputDir = path.join(BUILD_ROOT, job.id);
  try {
    setJob(job, { state: 'building', percent: 5, message: 'تم التحقق من البيانات، جارٍ تجهيز مشروع Android.' });
    ensureKeystore();
    writeAndroidProject(projectDir, job.appName, job.siteUrl);
    setJob(job, { percent: 15, message: 'تم تجهيز مشروع WebView حقيقي، جارٍ تشغيل Gradle.' });
    const env = { ...process.env, ...(ANDROID_HOME ? { ANDROID_HOME, ANDROID_SDK_ROOT: ANDROID_HOME } : {}) };
    const gradle = spawn(GRADLE_BIN, ['--no-daemon', '--console=plain', 'assembleRelease'], { cwd: projectDir, env });
    let log = '';
    gradle.stdout.on('data', chunk => {
      const text = chunk.toString(); log += text;
      if (/compile|process.*Resources|merge.*Resources/i.test(text)) setJob(job, { percent: 40, message: 'Gradle يترجم كود التطبيق وموارد Android.' });
      else if (/dex|package|merge.*Java/i.test(text)) setJob(job, { percent: 65, message: 'Gradle يحزم التطبيق ويجهز ملف APK.' });
      else if (/BUILDING|Downloading/i.test(text)) setJob(job, { message: 'جارٍ تنفيذ أدوات البناء المطلوبة.' });
    });
    gradle.stderr.on('data', chunk => { log += chunk.toString(); });
    gradle.on('error', error => finish(false, `تعذر تشغيل Gradle: ${error.message}`));
    gradle.on('close', code => {
      if (code !== 0) { finish(false, `فشل بناء APK (رمز Gradle ${code}). راجع إعدادات Android SDK وGradle.`, log.slice(-5000)); return; }
      const apk = path.join(projectDir, 'app/build/outputs/apk/release/app-release.apk');
      if (!fs.existsSync(apk) || fs.statSync(apk).size < 10_000) { finish(false, 'انتهى Gradle دون إنشاء ملف APK صالح.'); return; }
      const finalName = `${job.id}-${job.appName.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 30) || 'app'}.apk`;
      const finalPath = path.join(outputDir, finalName);
      fs.copyFileSync(apk, finalPath);
      finish(true, 'تم إنشاء APK والتحقق من وجود الملف بنجاح.', '', `/api/build/${job.id}/download`);
    });
  } catch (error) { finish(false, error.message); }
  function finish(success, message, details = '', downloadUrl = null) {
    if (job.finishedAt) return;
    setJob(job, { state: success ? 'success' : 'failed', percent: success ? 100 : null, message, error: success ? null : `${message}${details ? `\n${details}` : ''}`, downloadUrl, finishedAt: Date.now() });
  }
}
function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'غير موجود' });
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}
const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS' && parsed.pathname.startsWith('/api/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }
    if (req.method === 'POST' && parsed.pathname === '/api/build') {
      const input = validateInput(await readBody(req));
      const id = crypto.randomBytes(8).toString('hex');
      const job = { id, ...input, state: 'queued', percent: 0, message: 'تم وضع الطلب في قائمة البناء.', startedAt: Date.now(), finishedAt: null };
      jobs.set(id, job); fs.mkdirSync(path.join(BUILD_ROOT, id), { recursive: true });
      setImmediate(() => runBuild(job));
      return json(res, 202, publicJob(job));
    }
    const match = parsed.pathname.match(/^\/api\/build\/([a-f0-9]+)$/);
    if (req.method === 'GET' && match) { const job = jobs.get(match[1]); return job ? json(res, 200, publicJob(job)) : json(res, 404, { error: 'عملية البناء غير موجودة.' }); }
    const download = parsed.pathname.match(/^\/api\/build\/([a-f0-9]+)\/download$/);
    if (req.method === 'GET' && download) {
      const job = jobs.get(download[1]); if (!job || job.state !== 'success') return json(res, 404, { error: 'ملف APK غير جاهز.' });
      const file = fs.readdirSync(path.join(BUILD_ROOT, job.id)).find(name => name.endsWith('.apk'));
      if (!file) return json(res, 404, { error: 'ملف APK غير موجود.' });
      res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': `attachment; filename="${file}"` });
      return fs.createReadStream(path.join(BUILD_ROOT, job.id, file)).pipe(res);
    }
    serveStatic(req, res);
  } catch (error) { json(res, 400, { error: error.message || 'حدث خطأ غير متوقع.' }); }
});
server.listen(PORT, '0.0.0.0', () => console.log(`Site-to-App builder listening on http://0.0.0.0:${PORT}`));
