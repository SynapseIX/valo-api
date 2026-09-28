const button = document.querySelector('#connectButton');

button.addEventListener('click', async () => {
  const status = document.querySelector('#status');
  if (window.location.protocol === 'file:') {
    status.textContent = 'Riot sign-in requires the running API server. Start it with npm start and open http://localhost:3000, or use https://valo-api.synapseix.pro.';
    return;
  }

  if (!document.querySelector('#consent').checked) {
    status.textContent = 'Please review and accept the data-sharing notice.';
    return;
  }

  button.disabled = true;
  status.textContent = 'Preparing Riot sign-in…';
  try {
    const region = encodeURIComponent(document.querySelector('#region').value);
    const response = await fetch(`/auth/riot/start?region=${region}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw Error(data.error?.message || 'Could not start sign-in');
    if (new URL(data.authorizationUrl).origin !== 'https://auth.riotgames.com') {
      throw Error('Invalid authentication destination');
    }
    window.location.assign(data.authorizationUrl);
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});
