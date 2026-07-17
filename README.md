# بوت اللوق واعتماد تسجيل الدخول 🔐

بوت ديسكورد + سيرفر صغير (API) يرسل رسالة "لوق" بروم ديسكورد لكل محاولة تسجيل دخول بموقعك، فيها معلومات الشخص وزرين **Accept** و **Reject**. موقعك يسأل السيرفر بعدها "هل تم القبول أو الرفض؟" ويتصرف حسب الجواب.

## خطوات الإعداد

### 1. سوّي بوت ديسكورد (لو ما عندك واحد)
نفس خطوات أي بوت عادي: https://discord.com/developers/applications → New Application → Bot → انسخ التوكن.

**صلاحيات مطلوبة عند إضافته للسيرفر (OAuth2 → URL Generator):**
- Scope: `bot`
- Permissions: `Send Messages`, `Embed Links`, `View Channel`

### 2. جهّز الروم المخصص للوق
سوّي روم نصي خاص بالأدمنية بس (مثلاً `#login-logs`)، وانسخ الـ **Channel ID** تبعه:
1. فعّل Developer Mode بديسكورد (User Settings → Advanced → Developer Mode)
2. اضغط يمين على الروم → **Copy Channel ID**

### 3. ثبّت المكتبات
```bash
npm install
```

### 4. جهّز ملف `.env`
انسخ `.env.example` باسم `.env` واملأ:
```
DISCORD_TOKEN=توكن_البوت
LOG_CHANNEL_ID=آيدي_الروم
API_KEY=نص_سري_طويل_تختاره_انت
ADMIN_ROLE_ID=
PORT=3000
```

⚠️ **API_KEY** هو "كلمة السر" اللي موقعك يستخدمها عشان يثبت هويته للسيرفر — اختر نص عشوائي طويل وخله سري تماماً.

### 5. شغّله
```bash
npm start
```

---

## كيف يتكامل مع موقعك

السيرفر يوفر **endpoint** (مسارين) عامين، أي موقع أو لغة برمجة تقدر تتواصل معهم (PHP, Node.js, Python...) عن طريق HTTP عادي.

### أ) لما شخص يحاول يسجل دخول — أرسل الطلب

```
POST https://عنوان-السيرفر-تبعك/api/login-attempt
Headers: x-api-key: نفس_API_KEY
Body (JSON):
{
  "discordId": "123456789012345678",
  "username": "user#1234",
  "country": "Saudi Arabia"
}
```

**الرد:**
```json
{ "requestId": "abc-123-...", "status": "pending" }
```

خزّن الـ `requestId` هذا مؤقتاً (بالجلسة أو الكوكيز) عشان تستخدمه بالخطوة الجاية.

### ب) اسأل عن القرار (كرر الطلب كل 2-3 ثواني لين يتغير الرد)

```
GET https://عنوان-السيرفر-تبعك/api/login-attempt/{requestId}
Headers: x-api-key: نفس_API_KEY
```

**الرد:**
```json
{ "status": "pending" }     // لسا ما رد الأدمن
{ "status": "accepted", ... }  // اقبل → خله يدخل الموقع
{ "status": "rejected", ... }  // ارفض → امنعه من الدخول
```

---

## مثال تكامل (JavaScript / Node.js)

```javascript
// 1. أرسل محاولة الدخول
const res = await fetch('https://عنوان-السيرفر-تبعك/api/login-attempt', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'نفس_API_KEY',
  },
  body: JSON.stringify({
    discordId: user.id,
    username: user.username,
    country: 'Saudi Arabia', // حدده حسب مصدر بياناتك (IP geolocation مثلاً)
  }),
});
const { requestId } = await res.json();

// 2. راقب القرار كل 2 ثانية
const interval = setInterval(async () => {
  const check = await fetch(`https://عنوان-السيرفر-تبعك/api/login-attempt/${requestId}`, {
    headers: { 'x-api-key': 'نفس_API_KEY' },
  });
  const data = await check.json();

  if (data.status === 'accepted') {
    clearInterval(interval);
    // اسمح له يدخل الموقع
  } else if (data.status === 'rejected') {
    clearInterval(interval);
    // امنعه من الدخول
  }
  // لو "pending" استمر بالانتظار
}, 2000);
```

## مثال تكامل (PHP)

```php
<?php
// 1. أرسل محاولة الدخول
$ch = curl_init('https://عنوان-السيرفر-تبعك/api/login-attempt');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: application/json',
    'x-api-key: نفس_API_KEY',
]);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
    'discordId' => $discordId,
    'username'  => $username,
    'country'   => $country,
]));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$response = json_decode(curl_exec($ch), true);
$requestId = $response['requestId'];

// 2. راقب القرار (استدعِ نفس الكود كل ثانيتين من جهة الفرونت إند بـ JavaScript،
// أو اعمل صفحة "انتظار الموافقة" تتحقق كل بضع ثواني)
```

---

## ملاحظات مهمة

- الطلبات المعلّقة تُحذف تلقائياً بعد 30 دقيقة من عدم الرد عليها (توفير للذاكرة).
- لو تبي تقيد الضغط على الأزرار بدور معين بس (مثلاً "Admin")، حط الـ Role ID بمتغير `ADMIN_ROLE_ID` بملف `.env`.
- البيانات تُخزّن بالذاكرة فقط (تختفي لو البوت أعاد التشغيل). لو تبي سجل دائم لكل المحاولات، أخبرني وأضيف قاعدة بيانات بسيطة.
- لاستضافته 24/7، تقدر تستخدم نفس طريقة Railway اللي استخدمناها بمشروع بوت الأغاني.
