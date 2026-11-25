(() => {
  "use strict";
  if (window.top !== window) return;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[offer-adder]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => min + Math.random() * (max - min);
  const strip = (s) => (typeof s === "string" ? s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "");
  const cookie = (name) => {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  };

  // Every adapter implements:
  //   cards():            -> [{id, name}]
  //   offers(card):       -> [{key, title, detail, raw}]   (only offers not yet added)
  //   add(card, offer):   -> {ok, status, retry?}
  const host = location.hostname;
  let adapter = null;

  // ---------------------------------------------------------------- AMEX
  const amex = {
    name: "American Express",
    delay: [200, 300],       // same cadence CardPointers uses
    concurrency: 1,
    pauseEvery: 100,         // longer breather after every 100 requests
    pauseMs: 3000,
    async cards() {
      let products;
      try {
        products = JSON.parse(localStorage.getItem("products") || "null");
      } catch (_) {}
      if (!Array.isArray(products)) throw new Error("Amex card list not found. Open amex.com's offers page first, then retry.");
      return products
        .filter((p) => {
          const st = Array.isArray(p.status) ? p.status[0] : p.status;
          return st !== "Canceled" && (p.lineOfBusiness === "CONSUMER" || p.lineOfBusiness === "COMPANY_CARD");
        })
        .map((p) => ({ id: p.id, name: p.description || p.name || p.id, locale: p.locale }));
    },
    async offers(card) {
      const out = new Map();
      for (let page = 1; page <= 10; page++) {
        const res = await fetch("https://functions.americanexpress.com/ReadOffersHubPresentation.web.v1", {
          method: "POST",
          headers: { accept: "application/json", "ce-source": "WEB", "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            accountNumberProxy: card.id,
            locale: card.locale || "en-US",
            offerPage: "page" + page,
            requestType: "OFFERSHUB_LANDING",
          }),
        });
        if (!res.ok) {
          if (page === 1) throw new Error("Amex offers request failed: " + res.status);
          break;
        }
        const j = await res.json();
        const list = j?.recommendedOffers?.offersList?.["page" + page] || [];
        if (!Array.isArray(list) || !list.length) break;
        let fresh = 0;
        for (const o of list) {
          if (!o?.id || out.has(o.id)) continue;
          fresh++;
          if (o.enrollmentDetails?.status === "ENROLLED") continue;
          out.set(o.id, {
            key: o.id,
            title: o.name || o.merchantName || o.id,
            detail: strip(o.short_description || o.description || o.shortDescription || ""),
            raw: o,
          });
        }
        if (!fresh) break;
        await sleep(400);
      }
      return [...out.values()];
    },
    async add(card, offer) {
      const d = new Date();
      const off = -d.getTimezoneOffset();
      const sign = off >= 0 ? "+" : "-";
      const p2 = (n) => String(Math.abs(n)).padStart(2, "0");
      const userOffset = `${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
      const stamp =
        `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T` +
        `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${userOffset}`;
      const res = await fetch("https://functions.americanexpress.com/CreateCardAccountOfferEnrollment.v1", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "ce-source": "offers.enroll" },
        credentials: "include",
        body: JSON.stringify({
          accountNumberProxy: card.id,
          identifier: offer.key,
          locale: card.locale || "en-US",
          requestDateTimeWithOffset: stamp,
          userOffset,
        }),
      });
      let j = null;
      try { j = await res.json(); } catch (_) {}
      const enrolled = j && j.isEnrolled && String(j.isEnrolled).toLowerCase() !== "false";
      if (res.status === 200 && enrolled) return { ok: true, status: 200 };
      // Already enrolled on another card counts as done, not a failure.
      if (res.status === 200 && j?.explanationCode === "PZN4107") return { ok: true, status: 200, note: "already on another card" };
      const ra = Number(res.headers.get("retry-after"));
      return {
        ok: false,
        status: res.status,
        retry: res.status === 429,
        retryAfterMs: ra > 0 ? ra * 1000 : 3000,
        note: j?.explanationCode,
      };
    },
  };

  // --------------------------------------------------------------- CHASE
  const chase = {
    name: "Chase",
    delay: [100, 250],
    concurrency: 3,
    eci() {
      const v = cookie("PC_1_0");
      const m = v && v.match(/ECI=([^|]+)/);
      if (!m) throw new Error("Chase customer id not found in cookies. Reload the Chase dashboard and retry.");
      return m[1];
    },
    async cards() {
      const res = await fetch(`${location.origin}/svc/rr/accounts/secure/v1/dashboard/overview/accounts/list`, {
        method: "POST",
        headers: {
          accept: "*/*",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-jpmc-channel": "id=C30",
          "x-jpmc-client-request-id": "",
          "x-jpmc-csrf-token": "NONE",
        },
        credentials: "include",
        body: "refresh=false",
      });
      if (!res.ok) throw new Error("Chase card list failed: " + res.status);
      const j = await res.json();
      return (j.accounts || [])
        .filter((a) => a.groupType === "CARD" && !a.detail?.closed)
        .map((a) => ({ id: String(a.id), name: a.nickname || a.detail?.cardType || String(a.id) }));
    },
    async offers(card) {
      const eci = this.eci();
      const url =
        `${location.origin}/svc/wr/profile/secure/gateway/ccb/marketing/offer-management/digital-customer-targeted-offers/v3/customer-offers` +
        `?offer-count=&offerStatusNameList=NEW,ACTIVATED,SERVED&source-application-system-name=CHASE_WEB` +
        `&source-request-component-name=OFFERS_HUB_CAROUSELS&is-include-summary=true`;
      const res = await fetch(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "path-params": JSON.stringify({ enterprisePartyIdentifier: eci, primaryDigitalAccountIdentifierList: [Number(card.id)] }),
          "channel-identifier": "C30",
          "channel-type": "WEB",
          "x-jpmc-channel": "id=C30",
          "x-jpmc-client-request-id": crypto.randomUUID(),
          "x-jpmc-csrf-token": "NONE",
        },
        credentials: "include",
        referrerPolicy: "no-referrer",
      });
      if (res.status === 204) return [];
      if (!res.ok) throw new Error("Chase offers request failed: " + res.status);
      const txt = await res.text();
      if (!txt) return [];
      const j = JSON.parse(txt);
      let list = j.customerOffers;
      if (list?.length) {
        const mine = list.find((x) => String(x.digitalAccountIdentifier) === card.id);
        list = mine?.offers || list[0].offers;
      }
      return (list || [])
        .filter((o) => o.offerStatusName !== "ACTIVATED")
        .map((o) => ({
          key: o.offerIdentifier,
          title: o.merchantDetails?.merchantName || o.MerchantName || o.offerIdentifier,
          detail: strip(o.offerDisplayDetails?.shortPreMessageText || o.offerDisplayDetails?.offerHeaderText || o.ShortPreMessage || ""),
          raw: o,
        }));
    },
    async add(card, offer) {
      const o = offer.raw;
      const q = new URLSearchParams({
        "recommendation-event-type-code": "CLICK",
        "recommendation-identifier": o.recommendationIdentifier,
        "enterprise-party-identifier": this.eci(),
        "source-application-system-name": "CHASE_WEB",
        "source-request-component-name": "OFFERS_HUB_ALL",
        "offer-identifier": o.offerIdentifier,
        "offer-impression-token-identifier": o.offerImpressionTokenIdentifier,
        "request-context": "MERCHANT_OFFERS",
        "offer-session-token-identifier": "",
        "digital-account-identifier": card.id,
      });
      const res = await fetch(
        "https://reco.chase.com/events/recoengine/public/recommendation/ccb/sales-relationship/crm/personalization-recommendation-interactions/v2/customer-interaction?" + q,
        { headers: { accept: "application/json, text/plain, */*" }, credentials: "omit" }
      );
      return { ok: res.ok, status: res.status, retry: res.status === 429 };
    },
  };

  // ---------------------------------------------------------------- CITI
  const citi = {
    name: "Citi",
    delay: [100, 250],
    concurrency: 1,
    useFallback: false,
    headers() {
      return {
        Accept: "application/json",
        "Accept-language": "en_US",
        "Content-Type": "application/json",
        TMXSessionId: cookie("tmx_sessionid"),
        appVersion: cookie("appVersion"),
        businessCode: cookie("businessCode"),
        channelId: cookie("channelId"),
        client_id: cookie("client_id"),
        countryCode: cookie("countryCode"),
        environmentID: "SuperMarioPROD",
      };
    },
    async call(url, method, body) {
      const res = await fetch(url, {
        method,
        headers: this.headers(),
        credentials: "include",
        body: body ? JSON.stringify(body) : undefined,
      });
      let j = null;
      try { j = await res.json(); } catch (_) {}
      return { status: res.status, body: j };
    },
    async cards() {
      const r = await this.call("https://online.citi.com/gcgapi/prod/public/v1/v2/digital/customers/dashboardTiles/accountDetails", "GET");
      if (r.status !== 200) throw new Error("Citi card list failed: " + r.status + ". Open your Citi dashboard first.");
      return (r.body?.creditCardAccount?.accountDetails || [])
        .filter((a) => a.accountStatus === "ACTIVE" && a.personalAccount == 1)
        .map((a) => ({ id: a.accountId, name: a.accountName || a.productName || a.accountId }));
    },
    async offers(card) {
      const r = await this.call("https://online.citi.com/gcgapi/prod/public/v1/digital/customers/creditCards/merchantOffers/retrieve", "POST", { accountId: card.id });
      if (r.status !== 200 || !Array.isArray(r.body?.merchantOffers)) throw new Error("Citi offers request failed: " + r.status);
      const seen = new Set();
      const out = [];
      for (const grp of r.body.merchantOffers) {
        for (const o of grp?.offers || []) {
          const key = o.offerId + "|" + (o.offerEndDate || "");
          if (seen.has(key) || o.offerStatus !== "AVAILABLE") continue;
          seen.add(key);
          out.push({
            key: o.offerId,
            title: o.merchantName || o.offerTitle || o.title || o.offerId,
            detail: strip(o.offerDescription || o.shortDescription || o.description || ""),
            raw: o,
          });
        }
      }
      return out;
    },
    async add(card, offer) {
      const body = { offerId: offer.raw.offerId, accountId: card.id };
      const primary = "https://online.citi.com/gcgapi/prod/public/v1/digital/customers/creditCards/accounts/rewards/specialOffers/enrollMerchantOffer";
      const fallback = "https://online.citi.com/gcgapi/prod/public/v1/digital/customers/creditCards/merchantOffers/enrollment";
      let r = await this.call(this.useFallback ? fallback : primary, "POST", body);
      if (r.status === 404 && !this.useFallback) {
        this.useFallback = true;
        r = await this.call(fallback, "POST", body);
      }
      const done = r.status === 200 && (r.body?.EnrolledOfferInfo?.enrollmentId || r.body?.enrollmentId);
      return { ok: !!done, status: r.status, retry: r.status === 429 };
    },
  };

  if (host === "global.americanexpress.com") adapter = amex;
  else if (host.endsWith(".chase.com")) adapter = chase;
  else if (host === "online.citi.com") adapter = citi;
  if (!adapter) return;

  // ------------------------------------------------------------------ UI
  const hostEl = document.createElement("div");
  hostEl.style.cssText = "position:fixed;inset:auto 16px 16px auto;z-index:2147483647";
  const root = hostEl.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      *{box-sizing:border-box}
      .fab{font:600 14px system-ui;padding:10px 14px;border:0;border-radius:8px;background:#0b57d0;color:#fff;cursor:pointer;box-shadow:0 2px 8px #0005}
      .panel{display:none;position:fixed;right:16px;bottom:64px;width:min(420px,calc(100vw - 32px));max-height:min(620px,calc(100vh - 96px));
        flex-direction:column;background:#fff;color:#1b1b1f;border-radius:12px;box-shadow:0 8px 32px #0006;font:14px system-ui}
      .panel.open{display:flex}
      header{padding:12px 14px;border-bottom:1px solid #ddd;display:flex;gap:8px;align-items:center}
      header b{flex:1}
      select,button{font:inherit}
      select{max-width:60%;padding:4px}
      .bar{padding:8px 14px;display:flex;gap:10px;align-items:center;border-bottom:1px solid #eee}
      .list{overflow:auto;flex:1;padding:4px 0}
      label.row{display:flex;gap:10px;padding:7px 14px;cursor:pointer;align-items:flex-start}
      label.row:hover{background:#f3f4f8}
      .t{font-weight:600}.d{color:#555;font-size:12px}
      .st{margin-left:auto;font-size:12px;white-space:nowrap}
      .ok{color:#0a7a2f}.bad{color:#b3261e}
      footer{padding:10px 14px;border-top:1px solid #ddd;display:flex;gap:8px;align-items:center}
      footer span{flex:1;font-size:12px;color:#555}
      .go{padding:8px 14px;border:0;border-radius:8px;background:#0b57d0;color:#fff;font-weight:600;cursor:pointer}
      .go:disabled{opacity:.5;cursor:default}
      .x{border:0;background:none;font-size:18px;cursor:pointer}
      .msg{padding:16px 14px;color:#555}
    </style>
    <button class="fab">Offers</button>
    <div class="panel" role="dialog" aria-label="Add offers">
      <header><b></b><select aria-label="Card"></select><button class="x" aria-label="Close">×</button></header>
      <div class="bar"><label><input type="checkbox" class="all"> Select all</label><span class="count"></span></div>
      <div class="list"></div>
      <footer><span class="status"></span><button class="go" disabled>Add selected</button></footer>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const fab = $(".fab"), panel = $(".panel"), sel = $("select"), list = $(".list");
  const all = $(".all"), go = $(".go"), status = $(".status"), count = $(".count");
  $("header b").textContent = adapter.name + " offers";

  let cards = [], offers = [], busy = false, stop = false;

  const setStatus = (t) => (status.textContent = t);
  const checks = () => [...list.querySelectorAll("input[type=checkbox]")];
  const refreshCount = () => {
    const n = checks().filter((c) => c.checked).length;
    count.textContent = offers.length ? `${n} of ${offers.length} selected` : "";
    go.disabled = busy ? false : n === 0;
    all.checked = offers.length > 0 && n === offers.length;
  };

  function renderMsg(text) {
    list.replaceChildren();
    const d = document.createElement("div");
    d.className = "msg";
    d.textContent = text;
    list.appendChild(d);
  }

  function renderOffers() {
    list.replaceChildren();
    if (!offers.length) return renderMsg("No unadded offers for this card.");
    offers.forEach((o, i) => {
      const row = document.createElement("label");
      row.className = "row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.i = i;
      cb.addEventListener("change", refreshCount);
      const box = document.createElement("div");
      const t = document.createElement("div"); t.className = "t"; t.textContent = o.title;
      const d = document.createElement("div"); d.className = "d"; d.textContent = o.detail;
      box.append(t, d);
      const st = document.createElement("span"); st.className = "st";
      row.append(cb, box, st);
      o.statusEl = st;
      list.appendChild(row);
    });
    refreshCount();
  }

  // sel option 0 is "All cards" when there is more than one card.
  const hasAll = () => cards.length > 1;
  const selectedCards = () => (hasAll() && sel.selectedIndex === 0 ? cards : [cards[sel.selectedIndex - (hasAll() ? 1 : 0)]]);

  async function loadOffers() {
    const targets = selectedCards().filter(Boolean);
    if (!targets.length) return;
    offers = [];
    renderMsg("Loading offers…");
    refreshCount();
    const errors = [];
    for (const card of targets) {
      try {
        const found = await adapter.offers(card);
        for (const o of found) {
          o.card = card;
          if (targets.length > 1) o.detail = `${card.name}${o.detail ? " · " + o.detail : ""}`;
          offers.push(o);
        }
        log("offers", card.name, found.length);
      } catch (e) {
        console.error("[offer-adder]", card.name, e);
        errors.push(`${card.name}: ${e.message || e}`);
      }
      if (targets.length > 1) await sleep(300);
    }
    renderOffers();
    if (errors.length) setStatus(errors.join(" | "));
  }

  async function loadCards() {
    renderMsg("Loading cards…");
    try {
      cards = await adapter.cards();
      if (!cards.length) return renderMsg("No eligible cards found.");
      const names = cards.map((c) => c.name);
      if (cards.length > 1) names.unshift("All cards");
      sel.replaceChildren(...names.map((n) => Object.assign(document.createElement("option"), { textContent: n })));
      await loadOffers();
    } catch (e) {
      console.error("[offer-adder]", e);
      renderMsg(e.message || String(e));
    }
  }

  async function addSelected() {
    const picks = checks().filter((c) => c.checked).map((c) => offers[Number(c.dataset.i)]);
    busy = true; stop = false;
    go.textContent = "Stop";
    go.disabled = false;
    all.disabled = sel.disabled = true;
    let done = 0, failed = 0, streak = 0, next = 0, sent = 0, pauseUntil = 0, tripped = false;

    const worker = async () => {
      while (!stop && !tripped) {
        const o = picks[next++];
        if (!o) return;
        const wait = pauseUntil - Date.now();
        if (wait > 0) await sleep(wait);
        let r;
        try { r = await adapter.add(o.card, o); } catch (e) { r = { ok: false, status: 0, note: String(e) }; }
        if (!r.ok && r.retry && !stop) {
          // Rate limited: pause every worker, then retry this offer once.
          const backoff = (r.retryAfterMs || 5000) + jitter(50, 150);
          pauseUntil = Date.now() + backoff;
          o.statusEl.textContent = "rate limited, waiting…";
          await sleep(backoff);
          try { r = await adapter.add(o.card, o); } catch (e) { r = { ok: false, status: 0 }; }
        }
        o.statusEl.className = "st " + (r.ok ? "ok" : "bad");
        o.statusEl.textContent = r.ok ? "added" : "failed " + (r.status || "");
        log("add", o.card.name, o.title, r);
        if (r.ok) { done++; streak = 0; } else { failed++; streak++; }
        setStatus(`${done} added, ${failed} failed of ${picks.length}`);
        if (streak >= 3) { tripped = true; setStatus(`Stopped after 3 failures in a row. ${done} added.`); return; }
        sent++;
        if (adapter.pauseEvery && sent % adapter.pauseEvery === 0) await sleep(adapter.pauseMs + jitter(50, 150));
        await sleep(jitter(...adapter.delay));
      }
    };
    await Promise.all(Array.from({ length: adapter.concurrency || 1 }, worker));

    busy = false;
    go.textContent = "Add selected";
    all.disabled = sel.disabled = false;
    if (!tripped) setStatus(`${stop ? "Stopped" : "Done"}: ${done} added, ${failed} failed.`);
    refreshCount();
  }

  fab.addEventListener("click", () => {
    panel.classList.toggle("open");
    if (panel.classList.contains("open") && !cards.length) loadCards();
  });
  $(".x").addEventListener("click", () => panel.classList.remove("open"));
  sel.addEventListener("change", loadOffers);
  all.addEventListener("change", () => {
    checks().forEach((c) => (c.checked = all.checked));
    refreshCount();
  });
  go.addEventListener("click", () => (busy ? ((stop = true), setStatus("Stopping…")) : addSelected()));

  document.documentElement.appendChild(hostEl);
})();
