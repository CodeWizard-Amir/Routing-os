# نسخه کامل Routine OS 1.2.0

این پوشه پروژه کامل است، نه فقط Patch. برای اعلان پس‌زمینه، ابتدا وابستگی‌ها را نصب و Environment Variables مندرج در `README_PUSH_FA.md` را در Vercel تنظیم کن.

```bash
npm install
npm run build
```

در Vercel Root Directory باید همان پوشه‌ای باشد که `package.json` و پوشه `app/` در آن قرار دارند.

توجه: اگر این پروژه را روی همان دامنه قبلی Deploy می‌کنی، IndexedDB همان دامنه حفظ می‌شود؛ داده‌های سایت مرورگر را پاک نکن.
