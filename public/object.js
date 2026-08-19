(function () {
  const slug = window.location.pathname.split('/').filter(Boolean)[1] || '';
  const statusEl = document.getElementById('geo-status');
  const latField = document.getElementById('latitude');
  const lngField = document.getElementById('longitude');
  const accField = document.getElementById('accuracy');

  function reportScan(position) {
    const body = position
      ? {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy
        }
      : {};
    if (position) {
      latField && (latField.value = position.coords.latitude);
      lngField && (lngField.value = position.coords.longitude);
      accField && (accField.value = position.coords.accuracy);
      if (statusEl) statusEl.textContent = '📍 Position partagée, merci !';
    } else if (statusEl) {
      statusEl.textContent = '';
    }
    fetch(`/o/${encodeURIComponent(slug)}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(() => {});
  }

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => reportScan(pos),
      () => reportScan(null),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  } else {
    reportScan(null);
  }
})();
