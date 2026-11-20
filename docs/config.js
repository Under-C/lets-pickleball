// ① 把 Firebase Console「專案設定 → 一般 → 你的應用程式」裡的 firebaseConfig 整段貼到這裡
//    （這段設定公開沒關係，安全性由 Firestore 規則與 Cloud Functions 控管）
export const firebaseConfig = {
  apiKey: "請貼上",
  authDomain: "lets-pickleball.firebaseapp.com",
  projectId: "lets-pickleball",
  storageBucket: "lets-pickleball.firebasestorage.app",
  messagingSenderId: "請貼上",
  appId: "請貼上",
};

// ② LIFF ID（請用 LINE Developers 的複製按鈕貼上）
export const LIFF_ID = "2012714773-8dkgI7FJ";

// Cloud Functions 所在區域
export const REGION = "asia-east1";
