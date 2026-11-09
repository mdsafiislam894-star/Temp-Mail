# 📨 Telegram Temp Mail Bot v2

Titan IMAP + Cloudflare Worker + Gmail সংযোগ + প্রিমিয়াম Telegram Mini App।

## চালু করার ধাপ
1. `cp .env.example .env` → `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (আপনি = Admin), `YOUR_DOMAINS` দিন।
2. `npm install && npm start` (অথবা Docker)।
3. Mini App ও Gmail এর জন্য সার্ভারের **HTTPS** ঠিকানা `PUBLIC_URL` এ দিন। বট নিজেই "🚀 Mail App" মেনু বাটন সেট করে।
4. Render/Railway তে `DATA_DIR` এ **Persistent Disk** দিন, নাহলে রিস্টার্টে ডাটা মুছে যাবে।

## ফিচার
- ⚡ `/gen` ইনস্ট্যান্ট মেইল (nova4821@domain), 🎯 `/custom নাম`, ✏️ Change Name, 🏷 Label
- 📬 Inbox (পেজিনেশন), 📄 Full Message (+ HTML ফাইল), 🗑 Delete
- 🔐 OTP অটো-ডিটেক্ট + ট্যাপ-টু-কপি, 🔗 ভেরিফাই লিংক বাটন
- 🟢🔴🔵 রঙিন বাটন (Bot API 9.4 `style`) — আপডেটেড Telegram অ্যাপে দেখা যায়
- 👑 Admin Panel: ইউজার অ্যাপ্রুভাল/ব্যান, স্ট্যাটস, ব্রডকাস্ট
- 📱 Mini App: লাইভ ইনবক্স, সার্চ/ফিল্টার, মেইল ভিউয়ার (Text/HTML সেফ), অ্যাড্রেস ম্যানেজার, Gmail, Admin
- 📧 Gmail: **Add Now → Continue with Gmail** → Google অ্যাকাউন্ট চুজার

## v3 নতুন
- 🎨 **৩টি অ্যাপ ডিজাইন** (Settings → ডিজাইন): 🍎 Glass (iOS ফ্লোটিং গ্লাস) • 🟠 Claude (ওয়ার্ম কমলা, সেরিফ) • ✨ Mix (গ্লাস + কমলা)। ১৪টি রঙের থিম: ডার্ক, লাইট, Clay, Cyber, Nebula…
- 🚀 লাইট মোড (ভারী ইফেক্ট বন্ধ করে আরও স্মুদ), View-Transition দিয়ে ডিজাইন/থিম বদলানোর অ্যানিমেশন
- ⏳ **মেয়াদি মেইল** (10m / 1h / 24h / ♾) — মেয়াদ শেষ হলে বট জানায় ও এক ট্যাপে +১ ঘণ্টা; মেয়াদ-শেষ ঠিকানার মেইল ড্রপ হয় (অন্য কারো কাছে যায় না)
- 🔐 `/codes` — সাম্প্রতিক কোডের ভল্ট, 🔕 সার্ভিস মিউট, Quick Panel-এ ১২ ঘণ্টার অ্যাক্টিভিটি গ্রাফ
- 🔎 **Inline mode:** যেকোনো চ্যাটে `@আপনার_বট` লিখলে সাম্প্রতিক কোড ও অ্যাড্রেস পাঠানো যায়
  → BotFather: `/setinline` → আপনার বট → placeholder দিন (যেমন: `code খুঁজুন…`)
- 👑 **অ্যাডমিন কন্ট্রোল প্যানেল** (অ্যাপ): Overview (২৪ ঘণ্টার চার্ট, সিস্টেম, Titan স্ট্যাটাস), Users (সার্চ, ডিটেইল, Approve/Ban, সরাসরি মেসেজ), Tools (ব্রডকাস্ট, Open/Approval মোড, মেয়াদ-সুইপ)
- 👆 ইনবক্সে সোয়াইপ: ডানে = পঠিত, বামে = ডিলিট

## v2.2 নতুন
- 🧠 Smart কার্ড: শুধু কোড এলে শুধু কোড-বাটন, শুধু লিংক এলে শুধু মূল লিংক, দুটো একসাথে এলে পাশাপাশি। মেইলে "Open in Mini App" বাটন নেই
- 📱 নতুন অ্যাপ UI: স্প্ল্যাশ, স্লাইডিং নেভিগেশন, SVG আইকন, পুল-টু-রিফ্রেশ, ড্র্যাগ-টু-ক্লোজ শিট, রিপল ও কনফেত্তি ইফেক্ট, তারিখ অনুযায়ী গ্রুপ

## v2.1
- 🎨 ৯টি থিম: Auto (টেলিগ্রামের সাথে মেলে), ডার্ক — Aurora, Ocean, Emerald, Rose, Obsidian; লাইট — Pearl, Sky, Blush
- ⚙️ Settings (বট + অ্যাপ): নোটিফিকেশন ON/OFF, শুধু OTP/লিংক মোড, কার্ড স্টাইল (rich / compact / minimal), OTP অটো-কপি, হ্যাপটিক
- 🚀 /start এ Quick Panel, ✅ সব পঠিত, 🧹 ইনবক্স খালি, লোডিং স্কেলিটন ও অ্যানিমেশন

## Gmail সেটআপ (একবার)
1. Google Cloud Console → নতুন প্রজেক্ট → **Gmail API** Enable।
2. OAuth consent screen: External। Scope: `gmail.readonly`। **Testing** মোডে নিজের Gmail গুলো Test user হিসেবে যোগ করুন।
3. Credentials → OAuth client ID → *Web application* → Redirect URI: `https://YOUR-APP/auth/google/callback`
4. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` `.env` এ দিন।
> ⚠️ Testing মোডে Google রিফ্রেশ টোকেন **৭ দিনে** মেয়াদ শেষ করে। স্থায়ী করতে "Publish app" করুন (নিজের ব্যবহারে "unverified" সতর্কতা এড়িয়ে চালিয়ে যাওয়া যায়)।

## Cloudflare Worker
```
cd worker && npm install
npx wrangler secret put INBOUND_SECRET      # .env এর সাথে একই
npx wrangler secret put TELEGRAM_BOT_TOKEN  # ফলব্যাক
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler deploy
```
Cloudflare → Email Routing → Catch-all → "Send to Worker" → `tempmail-forwarder`।

## টেস্ট
`npm test`
