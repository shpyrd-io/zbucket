(function () {
  try {
    var theme = localStorage.getItem('shpyrd.theme');
    var dark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (_) { /* Reading a legal document must not require storage. */ }
})();
