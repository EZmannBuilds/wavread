// Sign-up, forgot-password and reset-password: the password pages that are
// not sign-in itself (beta-auth.js keeps that, beside the one-time link).
//
// Buying never needs any of this. Checkout takes an email; a buyer's account
// is created by the purchase and they sign in with an email link, then set a
// password on /account if they want one. Sign-up here is for writers who want
// an account before they buy.
//
// No password is logged or kept: each is read from its field once, handed to
// Supabase Auth, and the field is cleared. None of the answers here says
// whether an email already has an account.

import { authErrorMessage, createAccountClient, passwordProblem, setStatus, sitePath } from "./account-client.js";

const absolute = (path) => new URL(sitePath(path), location.origin).href;

function unavailable(form) {
  const notice = document.querySelector("#setup-notice");
  if (notice) notice.hidden = false;
  const submit = form?.querySelector("button[type=submit]");
  if (submit) submit.disabled = true;
}

async function client(options) {
  try {
    return await createAccountClient(options);
  } catch {
    return null;
  }
}

async function initializeSignUp(form) {
  const submit = form.querySelector("button[type=submit]");
  const status = document.querySelector("#signup-status");
  const email = form.querySelector("#signup-email");
  const password = form.querySelector("#signup-password");
  const confirm = form.querySelector("#signup-confirm");
  form.addEventListener("submit", (event) => event.preventDefault());
  const ctx = await client();
  if (!ctx) return unavailable(form);
  const { supabase } = ctx;

  form.addEventListener("submit", async () => {
    if (submit.disabled || !form.reportValidity()) return;
    const problem = passwordProblem(password.value, confirm.value);
    if (problem) {
      setStatus(status, problem, "error", password);
      return;
    }
    submit.disabled = true;
    setStatus(status, "Creating your account…", "", email);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.value.trim().toLowerCase(),
        password: password.value,
        options: { emailRedirectTo: absolute("/account") },
      });
      password.value = "";
      confirm.value = "";
      if (error) {
        setStatus(status, authErrorMessage(error, "Sign-up is unavailable right now. Please try again shortly."), "error", email);
        return;
      }
      // With email confirmation on, which is how the project is meant to run,
      // there is no session until the link is opened. Without it, there is one
      // now and the account page can open.
      if (data?.session) {
        location.replace(sitePath("/account"));
        return;
      }
      form.reset();
      setStatus(status, "Check your email for a link to confirm your account. If this email already has an account, sign in or reset your password instead.", "success", email);
    } catch {
      password.value = "";
      confirm.value = "";
      setStatus(status, "Could not reach sign-up. Check your connection and try again.", "error", email);
    } finally {
      submit.disabled = false;
    }
  });
  submit.disabled = false;
}

async function initializeForgot(form) {
  const submit = form.querySelector("button[type=submit]");
  const status = document.querySelector("#forgot-status");
  const email = form.querySelector("#forgot-email");
  form.addEventListener("submit", (event) => event.preventDefault());
  const ctx = await client();
  if (!ctx) return unavailable(form);
  const { supabase } = ctx;

  form.addEventListener("submit", async () => {
    if (submit.disabled || !form.reportValidity()) return;
    submit.disabled = true;
    setStatus(status, "Sending a reset link…", "", email);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.value.trim().toLowerCase(), {
        redirectTo: absolute("/reset-password"),
      });
      // An unknown address is not an error here: Supabase answers it the same
      // way as a known one, and so does this page.
      if (error) {
        setStatus(status, authErrorMessage(error, "Password reset is unavailable right now. Please try again shortly."), "error", email);
        return;
      }
      form.reset();
      setStatus(status, "If an account uses that email, a reset link is on its way. It works once and expires shortly.", "success", email);
    } catch {
      setStatus(status, "Could not reach password reset. Check your connection and try again.", "error", email);
    } finally {
      submit.disabled = false;
    }
  });
  submit.disabled = false;
}

async function initializeReset(form) {
  const submit = form.querySelector("button[type=submit]");
  const status = document.querySelector("#reset-status");
  const password = form.querySelector("#reset-password");
  const confirm = form.querySelector("#reset-confirm");
  const loading = document.querySelector("#reset-loading");
  const invalid = document.querySelector("#reset-invalid");
  const done = document.querySelector("#reset-done");
  form.addEventListener("submit", (event) => event.preventDefault());
  // The reset link signs the reader in for this purpose; detectSessionInUrl
  // reads it from the address and removes it.
  const ctx = await client({ detectSessionInUrl: true });
  if (!ctx) {
    loading.hidden = true;
    return unavailable(form);
  }
  const { supabase } = ctx;
  const { data } = await supabase.auth.getSession();
  loading.hidden = true;
  if (!data?.session) {
    invalid.hidden = false;
    return;
  }
  const username = form.querySelector("#reset-username");
  if (username) username.value = data.session.user?.email ?? "";
  form.hidden = false;

  form.addEventListener("submit", async () => {
    if (submit.disabled || !form.reportValidity()) return;
    const problem = passwordProblem(password.value, confirm.value);
    if (problem) {
      setStatus(status, problem, "error", password);
      return;
    }
    submit.disabled = true;
    setStatus(status, "Saving your new password…", "", password);
    try {
      const { error } = await supabase.auth.updateUser({ password: password.value });
      password.value = "";
      confirm.value = "";
      if (error) {
        setStatus(status, authErrorMessage(error, "Your password could not be changed. Request a new link and try again."), "error", password);
        return;
      }
      // Whoever knew the old password may still be signed in somewhere.
      await supabase.auth.signOut({ scope: "others" }).catch(() => {});
      // The status line lives in the form; it moves out before the form hides.
      form.after(status);
      form.hidden = true;
      done.hidden = false;
      setStatus(status, "Your password is changed, and your other devices were signed out.", "success");
    } catch {
      password.value = "";
      confirm.value = "";
      setStatus(status, "Could not reach password reset. Check your connection and try again.", "error", password);
    } finally {
      submit.disabled = false;
    }
  });
  submit.disabled = false;
}

const signUp = document.querySelector("#signup-form");
const forgot = document.querySelector("#forgot-form");
const reset = document.querySelector("#reset-form");
if (signUp) initializeSignUp(signUp);
if (forgot) initializeForgot(forgot);
if (reset) initializeReset(reset);
