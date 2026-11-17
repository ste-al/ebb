// "Mission accomplished": spot pages that confirm a task is done (an order, a booking,
// a payment, a submitted application). Ebb then OFFERS to tuck away the tabs of that hunt.
// Nothing happens without a click, so a false positive costs one dismissed toast.

const URL_RULES = [
  { re: /(order|purchase)s?[-_/]?(confirm(ation|ed)?|complete[d]?|success(ful)?|received|placed|thank[-_]?you)/i, kind: 'order' },
  { re: /(checkout|payment|pay)[-_/](success(ful)?|complete[d]?|confirm(ation|ed)?|thank[-_]?you|done|finished)/i, kind: 'order' },
  { re: /(booking|reservation|itinerary)s?[-_/]?(confirm(ation|ed)?|complete[d]?|success(ful)?)/i, kind: 'booking' },
  { re: /application[-_/]?(submitted|received|complete[d]?|confirmation|success)/i, kind: 'application' },
  { re: /\/thank[-_]?you\b|\/thanks\b|\/dekujeme\b|\/danke\b/i, kind: null }, // weak on its own
];

const TEXT_RULES = [
  // English
  { re: /thank(s| you) for (your |the )?(order|purchase|booking|reservation)/i, kind: 'order' },
  { re: /\b(order|purchase) (has been |was |is )?(confirmed|placed|received|completed?)\b/i, kind: 'order' },
  { re: /\b(booking|reservation) (has been |was |is )?confirmed\b/i, kind: 'booking' },
  { re: /\byou(['’]| a)re (all )?booked\b/i, kind: 'booking' },
  { re: /\bpayment (was |has been )?(successful|received|completed?|confirmed)\b/i, kind: 'payment' },
  { re: /\bapplication (has been |was )?(submitted|received|sent)\b/i, kind: 'application' },
  { re: /thank(s| you) for (applying|your application)/i, kind: 'application' },
  // Czech
  { re: /d[ěe]kujeme za (va[šs]i |Va[šs]i )?(objedn[áa]vku|n[áa]kup|rezervaci)/i, kind: 'order' },
  { re: /objedn[áa]vk[ay] (byla )?(p[řr]ijata|potvrzena|odesl[áa]na|dokon[čc]ena)/i, kind: 'order' },
  { re: /rezervace (byla )?(potvrzena|dokon[čc]ena|p[řr]ijata)/i, kind: 'booking' },
  { re: /platba (prob[ěe]hla|byla) (úsp[ěe][šs]n[ěe]|p[řr]ijata)|platba prob[ěe]hla/i, kind: 'payment' },
  // German
  { re: /vielen dank f[üu]r (ihre|deine) (bestellung|buchung|reservierung)/i, kind: 'order' },
  { re: /(bestellung|buchung|reservierung) (ist |wurde )?(best[äa]tigt|eingegangen|abgeschlossen)/i, kind: 'order' },
  // French
  { re: /merci (pour|de) votre (commande|r[ée]servation|achat)/i, kind: 'order' },
  { re: /(commande|r[ée]servation) (est )?(confirm[ée]e|valid[ée]e)/i, kind: 'order' },
  // Spanish
  { re: /gracias por (tu|su) (pedido|compra|reserva)/i, kind: 'order' },
  { re: /(pedido|reserva) confirmad[oa]/i, kind: 'order' },
];

/** Matches "order number", "booking reference", "číslo objednávky"… on the page. */
export const REFERENCE_RE =
  /\b(order|confirmation|booking|reservation|reference|itinerary)\s*(number|no\.|no(?=\s*\d)|#|id|code|reference|ref)(?![a-z])|[čc][íi]slo (objedn[áa]vky|rezervace)|bestellnummer|buchungsnummer|num[ée]ro de (commande|r[ée]servation)/i;

/**
 * @param {{url:string, title?:string, headings?:string[], hasReference?:boolean}} signals
 * @returns {{kind:string, score:number, evidence:string[]}|null}
 */
export function detectMission({ url, title = '', headings = [], hasReference = false }) {
  let score = 0;
  let kind = null;
  const evidence = [];

  let path = '';
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return null;
  }

  for (const rule of URL_RULES) {
    if (rule.re.test(path)) {
      score += rule.kind ? 2 : 1;
      kind = kind ?? rule.kind;
      evidence.push('url');
      break;
    }
  }

  const text = [title, ...headings].filter(Boolean).join(' \n ');
  for (const rule of TEXT_RULES) {
    if (rule.re.test(text)) {
      score += 2;
      kind = kind ?? rule.kind;
      evidence.push('heading');
      break;
    }
  }

  if (hasReference) {
    score += 1;
    evidence.push('reference');
  }

  if (score >= 2 && (kind || score >= 3)) return { kind: kind ?? 'done', score, evidence };
  return null;
}

export const MISSION_WORDS = {
  order: 'Ordered',
  booking: 'Booked',
  payment: 'Paid',
  application: 'Applied',
  done: 'Done',
};
