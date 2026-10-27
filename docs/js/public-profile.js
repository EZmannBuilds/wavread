// A writer's public profile: /u/<slug> (or u.html?slug= on the local preview).
//
// One read, public_profile(slug), which answers a name, a bio and the titles
// of published articles, and never an email or an account id. A profile
// exists only once its holder chooses a slug on /account. Everything drawn here
// is text: a bio is shown as typed, never parsed as markup.

import { createAccountClient, fmtDate, showState, slugFromLocation } from "./account-client.js";

const STATES = ["profile-loading", "profile-missing", "profile-unavailable", "profile-content"];
const LANE_NAMES = { developer: "Developer", ai: "AI", musician: "Musician" };

function articleItem(article) {
  const item = document.createElement("li");
  const heading = document.createElement("h2");
  const link = document.createElement("a");
  // The articles build serves each post at /articles/<slug> (PR #8); community
  // posts share that namespace once the build reads content/articles/community/.
  link.href = `/articles/${encodeURIComponent(article.slug)}`;
  link.textContent = article.title;
  heading.append(link);
  const meta = document.createElement("p");
  meta.className = "field-help";
  const lanes = (article.lanes || []).map((lane) => LANE_NAMES[lane] || lane).join(", ");
  meta.textContent = [fmtDate(article.published_at, true), lanes].filter(Boolean).join(" · ");
  const summary = document.createElement("p");
  summary.textContent = article.summary;
  item.append(heading, meta, summary);
  return item;
}

async function initialize() {
  const slug = slugFromLocation();
  if (!slug) return showState(STATES, "profile-missing");
  let ctx = null;
  try {
    ctx = await createAccountClient({ detectSessionInUrl: false });
  } catch {
    ctx = null;
  }
  if (!ctx) return showState(STATES, "profile-unavailable");
  const { data, error } = await ctx.supabase.rpc("public_profile", { profile_slug: slug });
  if (error) return showState(STATES, "profile-unavailable");
  if (!data) return showState(STATES, "profile-missing");

  const name = data.display_name || data.public_slug;
  document.querySelector("#profile-name").textContent = name;
  document.title = `${name} — WavRead`;
  const bio = document.querySelector("#profile-bio");
  bio.textContent = data.bio || "";
  bio.hidden = !data.bio;
  const articles = data.articles || [];
  document.querySelector("#profile-articles").replaceChildren(...articles.map(articleItem));
  document.querySelector("#profile-articles-empty").hidden = articles.length > 0;
  showState(STATES, "profile-content");
}

if (document.querySelector("#profile-content")) initialize();
