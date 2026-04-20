import { test } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Invitee } from "@prisma/client";

import {
  ackEnabled,
  localeFor,
  emailCopy,
  smsCopy,
  type AckIntent,
} from "../../src/lib/inbound-ack";

// P14-M pin set — `src/lib/inbound-ack.ts` auto-ack copy +
// locale resolution + opt-out gate. Minimal-visibility extract:
// four file-private helpers (ackEnabled, localeFor, emailCopy,
// smsCopy) become `export` so tests can pin them directly. No
// other source change.
//
// These power the one-line confirmation sent back to an invitee
// after ingest() classifies their reply as attending / declined
// / stop. Every regression has a specific operator-visible mode:
//
//   ackEnabled drift → the opt-out env var silently stops
//     working (or starts sending acks that a customer disabled)
//
//   localeFor drift → bilingual invitees get the wrong language
//     confirmation (Arabic invitee gets English ack, or vice
//     versa)
//
//   email/smsCopy drift → operator-visible broken grammar, or
//     URL / campaign-name interpolation drops, or brand leak
//
// Copy parity is load-bearing: the same intent must produce the
// same shape across ar/en and across email/sms. A cut-paste bug
// that swapped the attending/declined branches would make
// "confirmed" confirmations arrive as "regrets noted" — a high-
// confusion operator-facing bug.

// ---------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------

function invitee(fields: { locale?: string | null } = {}): Invitee {
  // Tests only touch `invitee.locale` via localeFor. All other
  // Invitee fields are irrelevant to the pure-copy pin set; we
  // cast to sidestep the strict prisma shape.
  return { locale: fields.locale ?? null } as unknown as Invitee;
}

function campaign(fields: { locale?: string | null } = {}): Campaign {
  return { locale: fields.locale ?? null } as unknown as Campaign;
}

// Scoped env mutation — save, set, run, restore.
function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => T,
): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------
// ackEnabled
// ---------------------------------------------------------------

test("ackEnabled: INBOUND_AUTO_ACK unset → true (default-on)", () => {
  withEnv({ INBOUND_AUTO_ACK: undefined }, () => {
    assert.equal(ackEnabled(), true);
  });
});

test("ackEnabled: INBOUND_AUTO_ACK=true → true", () => {
  withEnv({ INBOUND_AUTO_ACK: "true" }, () => {
    assert.equal(ackEnabled(), true);
  });
});

test("ackEnabled: INBOUND_AUTO_ACK=false → false", () => {
  withEnv({ INBOUND_AUTO_ACK: "false" }, () => {
    assert.equal(ackEnabled(), false);
  });
});

test("ackEnabled: INBOUND_AUTO_ACK=0 → false", () => {
  withEnv({ INBOUND_AUTO_ACK: "0" }, () => {
    assert.equal(ackEnabled(), false);
  });
});

test("ackEnabled: INBOUND_AUTO_ACK=off → false", () => {
  withEnv({ INBOUND_AUTO_ACK: "off" }, () => {
    assert.equal(ackEnabled(), false);
  });
});

test("ackEnabled: case-insensitive (FALSE, OFF) → false", () => {
  // Pinned — toLowerCase is applied. A regression dropping it
  // would make "FALSE" pass through as ack-enabled.
  for (const v of ["FALSE", "False", "OFF", "Off"]) {
    withEnv({ INBOUND_AUTO_ACK: v }, () => {
      assert.equal(ackEnabled(), false, `case-insensitive: ${v}`);
    });
  }
});

test("ackEnabled: unknown value (e.g. 'disabled', 'no') → true (fail-open)", () => {
  // Pinned — ONLY "false", "0", "off" disable. Everything else
  // keeps acks on. A regression that inverted the logic (to
  // fail-closed on unknown) would silently disable acks for
  // every operator who typo'd the env var.
  for (const v of ["disabled", "no", "nope", "yes", "1"]) {
    withEnv({ INBOUND_AUTO_ACK: v }, () => {
      assert.equal(ackEnabled(), true, `unknown: ${v}`);
    });
  }
});

test("ackEnabled: empty string → true (?? does NOT fall back on '')", () => {
  // Subtle `??` semantics pin — empty string is NOT nullish, so
  // the default "true" does NOT kick in. But "" is also NOT in
  // the disable-triplet, so it lands on true via the return
  // expression. A regression to `||` would fall through to the
  // "true" default (same observable outcome today, but pinning
  // the path).
  withEnv({ INBOUND_AUTO_ACK: "" }, () => {
    assert.equal(ackEnabled(), true);
  });
});

// ---------------------------------------------------------------
// localeFor — fallback cascade.
// ---------------------------------------------------------------

test("localeFor: invitee.locale='ar' → 'ar' (invitee wins)", () => {
  assert.equal(
    localeFor(invitee({ locale: "ar" }), campaign({ locale: "en" })),
    "ar",
  );
});

test("localeFor: invitee.locale='en' → 'en'", () => {
  assert.equal(
    localeFor(invitee({ locale: "en" }), campaign({ locale: "ar" })),
    "en",
  );
});

test("localeFor: invitee.locale=null → campaign wins", () => {
  // Load-bearing cascade — if invitee has no locale preference,
  // the campaign default takes over.
  assert.equal(
    localeFor(invitee({ locale: null }), campaign({ locale: "ar" })),
    "ar",
  );
});

test("localeFor: invitee=null + campaign=null → DEFAULT_LOCALE env", () => {
  withEnv({ DEFAULT_LOCALE: "ar" }, () => {
    assert.equal(localeFor(invitee({ locale: null }), null), "ar");
  });
});

test("localeFor: all null → 'en' (final fallback)", () => {
  withEnv({ DEFAULT_LOCALE: undefined }, () => {
    assert.equal(localeFor(invitee({ locale: null }), null), "en");
  });
});

test("localeFor: case-insensitive ('AR' / 'Ar') → 'ar'", () => {
  // Pinned — toLowerCase is applied before the ar/en match. A
  // regression dropping it would misroute "AR" to 'en'.
  assert.equal(localeFor(invitee({ locale: "AR" }), null), "ar");
  assert.equal(localeFor(invitee({ locale: "Ar" }), null), "ar");
});

test("localeFor: unknown locale ('fr', 'de') → 'en' (safe fallback)", () => {
  // Only 'ar' is preserved; every other string falls to 'en'.
  // Pinned so a regression that preserved the raw locale
  // wouldn't leak 'fr' / 'de' / 'zh' into the template switch.
  assert.equal(localeFor(invitee({ locale: "fr" }), null), "en");
  assert.equal(localeFor(invitee({ locale: "de" }), null), "en");
});

test("localeFor: invitee.locale='' (empty) stops cascade — does NOT fall through to campaign", () => {
  // Pinned — `??` coalesces ONLY null/undefined, so empty
  // string wins over campaign. After toLowerCase it's still
  // empty, which isn't 'ar', so result is 'en'. A regression
  // to `||` would fall through to the campaign locale here.
  assert.equal(
    localeFor(invitee({ locale: "" }), campaign({ locale: "ar" })),
    "en",
  );
});

// ---------------------------------------------------------------
// emailCopy — 3 intents × 2 locales = 6 shape pins.
// ---------------------------------------------------------------

test("emailCopy: EN attending — subject + text shape", () => {
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const r = emailCopy("attending", "en", "Annual Gala", "https://x/r/t1");
    assert.equal(r.subject, "Confirmed — Annual Gala");
    assert.match(r.text, /Thank you\. We've saved you as attending Annual Gala\./);
    assert.match(r.text, /To change your reply: https:\/\/x\/r\/t1/);
    assert.match(r.text, /— TestBrand$/);
  });
});

test("emailCopy: EN declined — subject + text shape", () => {
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const r = emailCopy("declined", "en", "Annual Gala", "https://x/r/t1");
    assert.equal(r.subject, "Regrets noted — Annual Gala");
    assert.match(
      r.text,
      /Thank you for letting us know\. We've recorded your regrets for Annual Gala\./,
    );
    assert.match(r.text, /If plans change: https:\/\/x\/r\/t1/);
    assert.match(r.text, /— TestBrand$/);
  });
});

test("emailCopy: EN stop — NO campaign name in subject, NO rsvp URL", () => {
  // Pinned — the stop branch is campaign-agnostic. A regression
  // that pasted the attending/declined template would leak the
  // RSVP URL to an unsubscribed user (embarrassing + a re-engage
  // loophole).
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const r = emailCopy("stop", "en", "Annual Gala", "https://x/r/t1");
    assert.equal(r.subject, "Unsubscribed");
    assert.equal(
      r.text,
      "You've been removed from TestBrand invitations. You won't receive further messages.",
    );
    assert.ok(
      !r.text.includes("https://"),
      "stop ack MUST NOT include rsvp URL",
    );
    assert.ok(
      !r.text.includes("Annual Gala"),
      "stop ack MUST NOT include campaign name",
    );
  });
});

test("emailCopy: AR attending — Arabic subject + text", () => {
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const r = emailCopy("attending", "ar", "الحفل", "https://x/r/t1");
    assert.equal(r.subject, "تأكيد الحضور — الحفل");
    assert.match(r.text, /شكراً لكم\. سجلنا حضوركم في «الحفل»/);
    assert.match(r.text, /لتعديل ردكم: https:\/\/x\/r\/t1/);
    assert.match(r.text, /— TestBrand$/);
  });
});

test("emailCopy: AR declined — Arabic subject + text", () => {
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const r = emailCopy("declined", "ar", "الحفل", "https://x/r/t1");
    assert.equal(r.subject, "اعتذار مسجّل — الحفل");
    assert.match(r.text, /شكراً لإعلامنا\. سجّلنا اعتذاركم عن «الحفل»/);
    assert.match(r.text, /إن تغيّرت الخطط: https:\/\/x\/r\/t1/);
  });
});

test("emailCopy: AR stop — Arabic unsubscribe, NO campaign name, NO URL", () => {
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const r = emailCopy("stop", "ar", "الحفل", "https://x/r/t1");
    assert.equal(r.subject, "تم إلغاء الاشتراك");
    assert.match(r.text, /^تم إلغاء اشتراككم من رسائل TestBrand/);
    assert.ok(
      !r.text.includes("https://"),
      "AR stop ack MUST NOT include rsvp URL",
    );
    assert.ok(
      !r.text.includes("الحفل"),
      "AR stop ack MUST NOT include campaign name",
    );
  });
});

test("emailCopy: BRAND defaults to 'Protocol' when APP_BRAND unset", () => {
  // Pinned — fallback chain `process.env.APP_BRAND ?? "Protocol"`.
  // A regression that hard-coded an empty string would leak
  // "— " with no brand into every ack.
  withEnv({ APP_BRAND: undefined }, () => {
    const r = emailCopy("attending", "en", "Gala", "https://x/r/t1");
    assert.match(r.text, /— Protocol$/);
  });
});

// ---------------------------------------------------------------
// smsCopy — 3 intents × 2 locales = 6 shape pins.
// ---------------------------------------------------------------

test("smsCopy: EN attending — single-line shape", () => {
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const s = smsCopy("attending", "en", "Annual Gala", "https://x/r/t1");
    assert.equal(
      s,
      "TestBrand: confirmed for Annual Gala. Change: https://x/r/t1",
    );
  });
});

test("smsCopy: EN declined", () => {
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const s = smsCopy("declined", "en", "Annual Gala", "https://x/r/t1");
    assert.equal(
      s,
      "TestBrand: regrets recorded for Annual Gala. Change: https://x/r/t1",
    );
  });
});

test("smsCopy: EN stop — no URL, no campaign name", () => {
  // Same stop discipline as email: never include the opt-out URL
  // on an unsubscribe confirmation.
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const s = smsCopy("stop", "en", "Annual Gala", "https://x/r/t1");
    assert.equal(
      s,
      "TestBrand: unsubscribed. You won't receive further messages.",
    );
    assert.ok(!s.includes("https://"), "stop SMS MUST NOT include URL");
    assert.ok(!s.includes("Annual Gala"), "stop SMS MUST NOT include campaign name");
  });
});

test("smsCopy: AR attending — Arabic single-line", () => {
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const s = smsCopy("attending", "ar", "الحفل", "https://x/r/t1");
    assert.equal(
      s,
      "TestBrand: سجّلنا حضوركم في «الحفل». للتعديل: https://x/r/t1",
    );
  });
});

test("smsCopy: AR declined", () => {
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const s = smsCopy("declined", "ar", "الحفل", "https://x/r/t1");
    assert.equal(
      s,
      "TestBrand: سجّلنا اعتذاركم عن «الحفل». للتعديل: https://x/r/t1",
    );
  });
});

test("smsCopy: AR stop", () => {
  withEnv({ APP_BRAND: "TestBrand" }, () => {
    const s = smsCopy("stop", "ar", "الحفل", "https://x/r/t1");
    assert.equal(s, "TestBrand: تم إلغاء الاشتراك. لن تصلكم رسائل جديدة.");
  });
});

// ---------------------------------------------------------------
// Cross-cutting parity checks.
// ---------------------------------------------------------------

test("parity: email attending subject != declined subject (NO cut-paste bug)", () => {
  // Canary — if someone accidentally swapped the two branches,
  // this pin catches it. Same structure for both locales.
  withEnv({ APP_BRAND: "B" }, () => {
    const a = emailCopy("attending", "en", "X", "u");
    const d = emailCopy("declined", "en", "X", "u");
    assert.notEqual(a.subject, d.subject);
    assert.notEqual(a.text, d.text);
    const aAr = emailCopy("attending", "ar", "X", "u");
    const dAr = emailCopy("declined", "ar", "X", "u");
    assert.notEqual(aAr.subject, dAr.subject);
  });
});

test("parity: sms attending != declined (same no-swap canary)", () => {
  withEnv({ APP_BRAND: "B" }, () => {
    assert.notEqual(
      smsCopy("attending", "en", "X", "u"),
      smsCopy("declined", "en", "X", "u"),
    );
    assert.notEqual(
      smsCopy("attending", "ar", "X", "u"),
      smsCopy("declined", "ar", "X", "u"),
    );
  });
});

test("parity: every intent×locale pair includes brand except never leaks in stop from other locale", () => {
  // Brand MUST appear in every output. (Stop branches use the
  // brand but not the URL/campaign-name.)
  withEnv({ APP_BRAND: "TESTBRAND" }, () => {
    for (const intent of ["attending", "declined", "stop"] as AckIntent[]) {
      for (const locale of ["en", "ar"] as const) {
        const e = emailCopy(intent, locale, "C", "https://u");
        const s = smsCopy(intent, locale, "C", "https://u");
        assert.ok(
          e.text.includes("TESTBRAND"),
          `email ${intent}/${locale} missing brand`,
        );
        assert.ok(
          s.includes("TESTBRAND"),
          `sms ${intent}/${locale} missing brand`,
        );
      }
    }
  });
});
