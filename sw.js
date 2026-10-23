// Só existe para exibir notificações no celular (Android exige service worker) e abrir o app ao tocar nelas.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('./'));
});
