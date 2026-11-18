// "Mission accomplished": spot pages that confirm a task is done (an order, a booking,
// a payment, a submitted application). Ebb then OFFERS to tuck away the tabs of that hunt.
// Nothing happens without a click, so a false positive costs one dismissed toast.

const URL_RULES = [
  { re: /(order|purchase)s?[-_/]?(confirm(ation|ed)?|complete[d]?|success(ful)?|received|placed|thank[-_]?you)/i, kind: 'order' },
  { re: /(checkout|payment|pay|buy)[-_/](success(ful)?|complete[d]?|confirm(ation|ed)?|thank[-_]?you|thanks|done|finished)/i, kind: 'order' },
  { re: /(booking|reservation|itinerary)s?[-_/]?(confirm(ation|ed)?|complete[d]?|success(ful)?)/i, kind: 'booking' },
  { re: /application[-_/]?(submitted|received|complete[d]?|confirmation|success)/i, kind: 'application' },
  { re: /(registration|signup|sign-up)[-_/]?(complete[d]?|confirm(ation|ed)?|success(ful)?)/i, kind: 'registration' },
  { re: /\/thank[-_]?you\b|\/thanks\b|\/dekujeme\b|\/danke\b/i, kind: null }, // weak on its own
];

// Within one sentence: "Your booking in Lisbon is confirmed", "Your order #1234 has been placed".
const SAME_SENTENCE = String.raw`[^.!?\n]{0,40}?`;

const TEXT_RULES = [
  // English
  { re: /thank(s| you) for (your |the )?(order|purchase)/i, kind: 'order' },
  { re: /thank(s| you) for (your |the )?(booking|reservation|stay)/i, kind: 'booking' },
  { re: /thank(s| you) for (your |the )?payment/i, kind: 'payment' },
  { re: /\b(order|purchase) (has been |was |is )?(confirmed|placed|received|completed?)\b/i, kind: 'order' },
  { re: new RegExp(String.raw`\border\b${SAME_SENTENCE}\b(has been|was|is) (confirmed|placed|received)\b`, 'i'), kind: 'order' },
  { re: /\b(order|purchase|checkout) (is )?complete\b/i, kind: 'order' },
  { re: /(^|\n)\s*(your )?order confirm(ation|ed)\b/im, kind: 'order' },
  { re: new RegExp(String.raw`\b(booking|reservation|stay|trip|flight|tickets?)\b${SAME_SENTENCE}\b(is|are|has been|have been|was) confirmed\b`, 'i'), kind: 'booking' },
  { re: /\byou(['’]| a)re (all )?booked\b/i, kind: 'booking' },
  { re: /\bpayment (was |has been |is )?(successful|received|completed?|confirmed)\b/i, kind: 'payment' },
  { re: /\bapplication (has been |was )?(submitted|received|sent)\b/i, kind: 'application' },
  { re: /thank(s| you) for (applying|your application)/i, kind: 'application' },
  { re: /\b(registration|sign[- ]?up) (is |was )?(complete|confirmed|successful)\b|\byou(['’]| a)re (all )?registered\b/i, kind: 'registration' },
  // Czech
  { re: /d[ěe]kujeme za (va[šs]i |Va[šs]i )?(objedn[áa]vku|n[áa]kup)/i, kind: 'order' },
  { re: /d[ěe]kujeme za (va[šs]i |Va[šs]i )?rezervaci/i, kind: 'booking' },
  { re: /objedn[áa]vk[ay] (byla )?(úsp[ěe][šs]n[ěe] )?(p[řr]ijata|potvrzena|odesl[áa]na|dokon[čc]ena|vytvo[řr]ena)/i, kind: 'order' },
  { re: /rezervace (byla )?(úsp[ěe][šs]n[ěe] )?(potvrzena|dokon[čc]ena|p[řr]ijata|vytvo[řr]ena)/i, kind: 'booking' },
  { re: /platba (prob[ěe]hla|byla) (úsp[ěe][šs]n[ěe]|p[řr]ijata)|platba prob[ěe]hla/i, kind: 'payment' },
  // German
  { re: /vielen dank f[üu]r (ihre|deine|ihren|deinen) (bestellung|einkauf|kauf)/i, kind: 'order' },
  { re: /vielen dank f[üu]r (ihre|deine) (buchung|reservierung)/i, kind: 'booking' },
  { re: /(bestellung) (ist |wurde )?(erfolgreich )?(best[äa]tigt|eingegangen|abgeschlossen|aufgegeben)|\bbestellbest[äa]tigung\b/i, kind: 'order' },
  { re: /(buchung|reservierung) (ist |wurde )?(erfolgreich )?(best[äa]tigt|abgeschlossen)|\bbuchungsbest[äa]tigung\b/i, kind: 'booking' },
  // French
  { re: /merci (pour|de) votre (commande|achat)/i, kind: 'order' },
  { re: /merci (pour|de) votre r[ée]servation/i, kind: 'booking' },
  { re: /\bcommande (a [ée]t[ée] |est )?(confirm[ée]e|valid[ée]e|enregistr[ée]e)/i, kind: 'order' },
  { re: /\br[ée]servation (a [ée]t[ée] |est )?(confirm[ée]e|valid[ée]e|enregistr[ée]e)/i, kind: 'booking' },
  // Spanish
  { re: /gracias por (tu|su) (pedido|compra)/i, kind: 'order' },
  { re: /gracias por (tu|su) reserva/i, kind: 'booking' },
  { re: /\b(pedido|compra) (ha sido )?(confirmad[oa]|realizad[oa]|completad[oa])/i, kind: 'order' },
  { re: /\breserva (ha sido )?(confirmad[oa]|realizad[oa]|completad[oa])/i, kind: 'booking' },
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
  registration: 'Registered',
  done: 'Done',
};
