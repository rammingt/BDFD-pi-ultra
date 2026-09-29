// Lets phones install the panel as an app. Everything still loads live from the Pi.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('fetch', () => {});
