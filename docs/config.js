// ① 把 Firebase Console「專案設定 → 一般 → 你的應用程式」裡的 firebaseConfig 整段貼到這裡
//    （這段設定公開沒關係，安全性由 Firestore 規則與 Cloud Functions 控管）
export const firebaseConfig = {
  apiKey: "AIzaSyATa4f0f5CzunkqoSDk16RUwpCV1P7DmwU",
  authDomain: "lets-pickleball.firebaseapp.com",
  projectId: "lets-pickleball",
  storageBucket: "lets-pickleball.firebasestorage.app",
  messagingSenderId: "779987063313",
  appId: "1:779987063313:web:19723e32c2c155900857b0"
};

// ② LIFF ID
export const LIFF_ID = "2012714773-8dkgI7FJ";

// Cloud Functions 所在區域
export const REGION = "asia-east1";
