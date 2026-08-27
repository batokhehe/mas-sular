/* eslint-disable no-undef */
/**
 * Firebase Cloud Messaging service worker (background web push).
 *
 * TEMPLATE — inert until you fill in the Firebase web config below.
 * Activation steps (matches the backend's optional FIREBASE_SERVICE_ACCOUNT_JSON):
 *   1. Create a Firebase project + Web app; copy its config object here.
 *   2. `pnpm add firebase` in admin/ and request an FCM token in the app
 *      (getToken({ vapidKey, serviceWorkerRegistration })), then POST it to
 *      /api/v1/admin/push/register (see registerPushToken in lib/notifications.ts).
 *   3. Set FIREBASE_SERVICE_ACCOUNT_JSON on the backend so the push channel sends.
 *
 * Foreground notifications are already covered by SSE + toasts; this worker
 * only matters when the admin tab is closed or in the background.
 */
const FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  messagingSenderId: '',
  appId: '',
};

if (FIREBASE_CONFIG.projectId) {
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

  firebase.initializeApp(FIREBASE_CONFIG);
  const messaging = firebase.messaging();

  // Background pushes: show the notification and deep-link on click.
  messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || 'Notification';
    const body = (payload.notification && payload.notification.body) || '';
    const url = (payload.data && payload.data.url) || '/';
    self.registration.showNotification(title, { body, data: { url } });
  });

  self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(clients.openWindow(url));
  });
}
