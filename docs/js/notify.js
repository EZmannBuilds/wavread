// Public anon JWT for the enabled Supabase JWT gate; never a database service credential.
(() => {
  const form = document.querySelector('#notify-form');
  const email = document.querySelector('#notify-email');
  const message = document.querySelector('#signup-status');
  const button = form.querySelector('button[type=submit]');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity() || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Saving…';
    message.dataset.state = 'loading';
    message.textContent = 'Saving your notification preference…';
    email.removeAttribute('aria-invalid');
    try {
      const response = await fetch('https://aodccnadwomafotizssk.supabase.co/functions/v1/notification-signup', {
        method: 'POST', signal: AbortSignal.timeout(15000), headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFvZGNjbmFkd29tYWZvdGl6c3NrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NjA5MDEsImV4cCI6MjEwMzQzNjkwMX0.5IFZ0sPPQopW6gemHHknbksjDlOXsgvcx3Qadi9sDkc'},
        body: JSON.stringify({email: email.value.trim(), marketing_opt_in: document.querySelector('#marketing-opt-in').checked})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.saved !== true) {
        if (response.status === 400) email.setAttribute('aria-invalid', 'true');
        throw new Error(data.error || 'Your signup could not be saved. Please try again.');
      }
      message.dataset.state = 'success';
      message.textContent = data.message;
      email.value = '';
    } catch (error) {
      message.dataset.state = 'error';
      message.textContent = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'Saving took too long. Please try again.' : error.message === 'Failed to fetch' ? 'Could not reach the signup service. Please try again.' : error.message;
    } finally {
      button.disabled = false;
      button.textContent = 'Notify me';
    }
  });
  button.disabled = false;
})();
