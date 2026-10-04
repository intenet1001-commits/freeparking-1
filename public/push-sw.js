/* Push only: page requests are never intercepted or cached. */
self.addEventListener('push', (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { /* empty notification */ }
  const title = typeof message.title === 'string' ? message.title : '무료주차 알림';
  const body = typeof message.body === 'string' ? message.body : '앱에서 현황을 확인해주세요.';
  const tag = typeof message.tag === 'string' ? message.tag : 'freeparking';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    icon: '/icon.svg',
    data: { url: '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow('/');
  })());
});
