/**
 * LINE Daily Report Bot
 * บันทึกข้อความจากกลุ่ม LINE ลง Google Sheets อัตโนมัติ แล้วสรุปรายงานประจำวัน
 * (ยอดผู้ป่วย / การติดตามเคส / เหตุการณ์ผิดปกติ) โดยไม่ต้อง export แชท
 *
 * Script Properties ที่ต้องตั้ง (Project Settings > Script Properties):
 *   LINE_TOKEN        = Channel access token (long-lived) ของ LINE Messaging API  [จำเป็น]
 *   ALLOWED_CHATS     = groupId ที่อนุญาต คั่นด้วยจุลภาค (เว้นว่าง = รับทุกกลุ่ม)     [แนะนำ]
 *   SUMMARY_EMAIL     = อีเมลที่จะรับสรุปรายวัน (ฟรี ไม่กินโควตา LINE)               [ไม่บังคับ]
 */

/******************** ตั้งค่า ********************/
const CONFIG = {
  TZ: 'Asia/Bangkok',
  SUMMARY_HOUR: 18,        // เวลาสรุปอัตโนมัติทุกวัน (0-23)
  AUTO_PUSH: false,        // true = ส่งสรุปเข้ากลุ่ม LINE อัตโนมัติ (นับโควตาข้อความ × จำนวนสมาชิก)
  EXPECTED_WARDS: [],      // เช่น ['อายุรกรรม 1','ศัลยกรรม 2'] เพื่อแจ้งวอร์ดที่ยังไม่ส่งยอด
  SUMMARY_WORD: 'สรุป',    // คำขึ้นต้นคำสั่ง เช่น "สรุป", "สรุปสัปดาห์", "สรุป Admit เดือน"
  HELP_WORDS: ['คำสั่ง', 'วิธีใช้', 'ช่วยเหลือ', 'help'],
  MAX_RANGE_DAYS: 366,     // ช่วงวันที่สรุปได้ยาวสุด
  INCIDENT_KEYWORDS: ['ผิดปกติ', 'ด่วน', 'พลัดตก', 'ตกเตียง', 'แพ้ยา', 'ให้ยาผิด', 'ผิดพลาด',
    'ทรุด', 'code blue', 'cpr', 'ร้องเรียน', 'หนีออก', 'ช็อก', 'shock', 'ชัก'],
  // คำใน Reply ที่แปลว่า "เรื่องนี้เสร็จแล้ว" (ไม่สนเว้นวรรค/ตัวพิมพ์)
  DONE_WORDS: ['ประกันตอบกลับ', 'ตอบกลับแล้ว', 'อนุมัติ', 'ได้รับแล้ว', 'เรียบร้อย', 'ปิดเคส', 'ปิดเรื่อง', 'จบเคส', 'เสร็จแล้ว'],
  MAX_THREADS: 15,         // จำนวนเรื่องสูงสุดที่แสดงเป็นข้อความ (กรณีไม่ใช้การ์ด)
  USE_CARDS: true,         // true = สรุปเรื่องที่ติดตามเป็นการ์ด 1 ใบต่อ 1 เรื่อง
  MAX_CARDS: 36,           // การ์ดสูงสุดต่อครั้ง (12 ใบ/ชุด เลื่อนซ้ายขวาได้, สูงสุด 3 ชุด)
  MAX_OPEN_CASES: 30,      // จำนวนเคสค้างสูงสุดที่แสดงในสรุป
  TRACK_LOOKBACK_DAYS: 180, // งานติดตามที่ยังไม่จบ ย้อนดูได้กี่วัน
  MAX_LEN: 4900,           // LINE จำกัดข้อความละ 5,000 ตัวอักษร
};

/**
 * งานติดตามแบบมีขั้นตอน (ไม่อิงระยะเวลา)
 * - keyword: คำที่อยู่ในข้อความแรกของเรื่อง (สะกดแบบไหนก็ได้ เช่น "Pre fax", "prefax", "PRE-FAX")
 * - stages: ขั้นตอนเรียงจากต้นไปจบ; ขั้นแรกคือค่าเริ่มต้น ขั้นอื่นดูจากคำใน Reply
 *   บอทใช้ "ขั้นที่ไปถึงไกลที่สุด" ของเรื่องนั้น; ignore = ส่วนของข้อความที่ไม่นำมาตัดสิน
 *   end: true = ขั้นที่ถือว่าจบเรื่อง; close: true = ปิดเคสได้จากทุกขั้น (เช่น ไม่อนุมัติ/ผู้ป่วยไม่ประสงค์ทำ)
 */
/**
 * ประเภทผู้ป่วย: บอทดูจากชื่อกลุ่มในรายงาน (บรรทัดอย่าง "#ผู้ป่วยอายุรกรรม 69 Case")
 * ทุกคำสั่งสรุปจะมีบรรทัด "แยกประเภท" เสมอ
 */
const CATEGORIES = [
  { label: 'Med', re: /อายุรกรรม|med(?!ic)/i },
  { label: 'Psy', re: /จิตเวช|psy/i },
];
const CAT_UNKNOWN = 'ไม่ระบุ';
function catOf_(group) {
  const g = String(group || '');
  const c = CATEGORIES.find(x => x.re.test(g));
  return c ? c.label : CAT_UNKNOWN;
}
const CAT_ALL = CATEGORIES.map(c => c.label).concat([CAT_UNKNOWN]);

/** รวมยอดตามประเภท เช่น "Med 533 | Psy 18 | ไม่ระบุ 45" */
function catLine_(pairs) {          // pairs = [[groupName, number], ...]
  const sum = {};
  pairs.forEach(([g, n]) => { const c = catOf_(g); sum[c] = (sum[c] || 0) + (Number(n) || 0); });
  const order = CAT_ALL.filter(c => sum[c]);
  return order.length ? order.map(c => c + ' ' + sum[c]).join(' | ') : '';
}

/**
 * ตัวเลขรายวันแยกประเภทในบรรทัดเดียว เช่น
 *   รายวัน (Med,Psy): 26/09=36,2, 27/09=38,3
 * triples = [[วันที่, ชื่อกลุ่ม, จำนวน], ...]
 */
function dailyCatLine_(triples) {
  const daily = {}, used = {};
  triples.forEach(([d, g, n]) => {
    const c = catOf_(g), day = dateStr_(d);
    daily[day] = daily[day] || {};
    daily[day][c] = (daily[day][c] || 0) + (Number(n) || 0);
    used[c] = true;
  });
  const cats = CAT_ALL.filter(c => used[c]);
  const ds = Object.keys(daily).sort();
  if (!ds.length) return '';
  return 'รายวัน (' + cats.join(',') + '): ' +
    ds.map(d => shortDate_(d) + '=' + cats.map(c => daily[d][c] || 0).join(',')).join(', ');
}

const TRACKERS = [
  {
    name: 'Pre fax',
    keyword: /pre\s*-?\s*fax/i,
    stages: [
      { label: 'Pre fax', color: '#2F6FDB' },
      { label: 'รอประกันตอบกลับ', color: '#E08A00', re: /รอ\s*(ประกัน\s*)?(ตอบกลับ|ตอบ)/ },
      { label: 'ตอบกลับ / อนุมัติ', color: '#06C755', re: /ตอบกลับ|อนุมัติ/, ignore: /รอ\s*(ประกัน\s*)?(ตอบกลับ|ตอบ)/g },
      { label: 'OR แล้ว', color: '#7B61FF', re: /(^|[^a-z])or\s*แล้ว|ผ่าตัดแล้ว/i, end: true },
      { label: 'ปิดเคส', color: '#6B7280', re: /ปิดเคส|ปิดเรื่อง|จบเคส/, end: true, close: true },
    ],
  },
  {
    name: 'Sleep test',
    keyword: /sleep\s*-?\s*test/i,
    showAppointment: true,     // แสดงวันนัดที่อ่านได้จากข้อความ เช่น 25/09/69
    stages: [
      { label: 'นัดทำ', color: '#2F6FDB' },
      { label: 'ทำแล้ว', color: '#06C755', re: /ทำแล้ว|ตรวจแล้ว|ทำเสร็จ|ทำ\s*sleep\s*test\s*แล้ว/i, ignore: /นัด\s*ทำ/g, end: true },
      { label: 'ปิดเคส', color: '#6B7280', re: /ปิดเคส|ปิดเรื่อง|จบเคส/, end: true, close: true },
    ],
  },
];

const TAGS = {
  census: /#(ยอดผู้ป่วย|ยอด|census)/i,
  case: /#(เคส|case)/i,
  incident: /#(ผิดปกติ|เหตุการณ์|incident)/i,
};

const KEYS = {
  ward: ['วอร์ด', 'หอผู้ป่วย', 'หน่วย', 'ward'],
  admit: ['รับใหม่', 'รับ', 'admit'],
  discharge: ['จำหน่าย', 'กลับบ้าน', 'd/c', 'discharge'],
  refer: ['ส่งต่อ', 'refer', 'ย้าย'],
  death: ['เสียชีวิต', 'dead', 'death'],
  remain: ['คงเหลือ', 'ยอดคงเหลือ', 'รวม', 'census'],
  note: ['หมายเหตุ', 'note'],
  caseId: ['เคส', 'รหัส', 'hn', 'an', 'case'],
  status: ['สถานะ', 'status'],
  detail: ['รายละเอียด', 'อาการ', 'แผน', 'detail'],
  severity: ['ระดับ', 'ความรุนแรง', 'severity'],
  event: ['เหตุการณ์', 'เรื่อง', 'event'],
  action: ['การจัดการ', 'แก้ไข', 'action'],
};

const SHEETS = {
  Messages: ['เวลา', 'วันที่', 'แชท', 'userId', 'ชื่อ', 'ประเภท', 'ข้อความ', 'แท็ก', 'messageId', 'ตอบกลับ messageId', 'quoteToken'],
  Census: ['เวลา', 'วันที่', 'แชท', 'ผู้รายงาน', 'วอร์ด', 'รับใหม่', 'จำหน่าย', 'ส่งต่อ', 'เสียชีวิต', 'คงเหลือ', 'หมายเหตุ'],
  Cases: ['เวลา', 'วันที่', 'แชท', 'ผู้รายงาน', 'รหัสเคส', 'สถานะ', 'รายละเอียด', 'messageId'],
  Incidents: ['เวลา', 'วันที่', 'แชท', 'ผู้รายงาน', 'ระดับ', 'เหตุการณ์', 'การจัดการ', 'ที่มา', 'messageId'],
  Dept: ['เวลา', 'วันที่รายงาน', 'แชท', 'ผู้รายงาน', 'แผนก', 'หน่วย', 'Total', 'กลุ่ม', 'รายการ', 'จำนวน', 'ปิดแผนก'],
  Summary: ['วันที่', 'แชท', 'สรุป', 'สร้างเมื่อ'],
  ChecklistLog: ['เวลา', 'วันที่', 'เวร', 'ลำดับ', 'รายการ', 'ผู้กด', 'userId'],
};

/******************** ติดตั้ง (รันครั้งเดียว) ********************/
function setup() {
  const ss = ss_();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(SHEETS[name]);
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('B:C').setNumberFormat('@'); // วันที่/แชท เก็บเป็นข้อความ
  });
  setupTrigger();
  setupChecklistTrigger();
}

function setupSheetsOnly_() {
  const ss = ss_();
  Object.keys(SHEETS).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh) sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
  });
}

function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailySummary')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailySummary').timeBased()
    .atHour(CONFIG.SUMMARY_HOUR).everyDays(1).inTimezone(CONFIG.TZ).create();
}

/******************** Webhook จาก LINE ********************/
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    (body.events || []).forEach(ev => {
      try { handleEvent_(ev); } catch (err) { console.error(err, JSON.stringify(ev)); }
    });
  } catch (err) {
    console.error(err);
  }
  return ContentService.createTextOutput('OK');
}

function doGet() {
  return ContentService.createTextOutput('LINE Daily Report Bot is running.');
}

function handleEvent_(ev) {
  const src = ev.source || {};
  const chatId = src.groupId || src.roomId || src.userId;

  if (ev.type === 'join') {
    replyText_(ev.replyToken, 'บอทบันทึกรายงานพร้อมใช้งาน\nรหัสกลุ่มนี้: ' + chatId +
      '\nพิมพ์ "สรุป" เพื่อดูสรุปของวันนี้');
    return;
  }
  // ติ๊กรายการเช็คลิสต์ประจำวัน
  if (ev.type === 'postback' && isAllowed_(chatId) && String(ev.postback.data || '').indexOf('ck=') === 0) {
    const card = checklistTick_(src, ev.postback.data);
    if (card) replyMessages_(ev.replyToken, [card]);
    return;
  }
  // กดปุ่มบนการ์ด → ตอบกลับโดยอ้างถึงข้อความล่าสุดของเรื่อง (แตะที่ข้อความอ้างถึงเพื่อเลื่อนไปยังตำแหน่งนั้นในแชท)
  if (ev.type === 'postback' && isAllowed_(chatId)) {
    const m = String(ev.postback.data || '').match(/^jump=(m\d+)$/);
    if (m) jumpToMessage_(ev.replyToken, chatId, m[1]);
    return;
  }
  if (ev.type !== 'message' || !isAllowed_(chatId)) return;

  const msg = ev.message;
  const text = msg.type === 'text' ? msg.text : '[' + msg.type + ']';
  const ts = new Date(ev.timestamp);

  // พิมพ์ "เช็คลิสต์" → แสดงเช็คลิสต์วันนี้พร้อมสถานะ (ติ๊กต่อได้)
  if (msg.type === 'text' && CHECKLIST_WORDS.includes(text.trim().toLowerCase())) {
    replyMessages_(ev.replyToken, [checklistMessage_(fmtDate_(ts))]);
    return;
  }

  // คำสั่งขอสรุป → ตอบกลับด้วย reply (ไม่เสียโควตา)
  const cmd = msg.type === 'text' && parseCommand_(text, fmtDate_(ts));
  if (cmd) {
    const res = runCommand_(chatId, cmd);
    if (typeof res === 'string') replyText_(ev.replyToken, res);
    else if (!replyMessages_(ev.replyToken, res.messages)) pushText_(chatId, res.fallback);
    return;
  }

  const name = getName_(src);
  recordMessage_(chatId, src.userId || '', name, msg.type, text, ts,
    msg.id ? 'm' + msg.id : '', msg.quotedMessageId ? 'm' + msg.quotedMessageId : '', msg.quoteToken || '');

  // รายงานเคสในกลุ่ม OPD1 → ร่างเคสในระบบรายงาน daily-report
  if (msg.type === 'text') {
    try {
      const ack = caseDraft_(chatId, name, text, ts, msg.id ? 'm' + msg.id : '', !!msg.quotedMessageId);
      if (ack && CASE_DRAFT.REPLY) replyText_(ev.replyToken, ack);
    } catch (err) { console.error('caseDraft', err); }
  }
}

/******************** บันทึกและแยกข้อมูล ********************/
// messageId เก็บแบบมีตัว m นำหน้า เพื่อไม่ให้ Google Sheets แปลงเลขยาวจนเพี้ยน
function recordMessage_(chatId, userId, name, type, text, ts, msgId, quotedId, quoteToken) {
  const tag = extract_(chatId, name, type, text, ts, msgId || '', quotedId || '');
  append_('Messages', [ts, fmtDate_(ts), chatId, userId, name, type, text, tag, msgId || '', quotedId || '', quoteToken || '']);
}

/** แยกข้อมูลจากข้อความลงชีต Census/Cases/Incidents/Dept แล้วคืนค่าแท็ก */
function extract_(chatId, name, type, text, ts, msgId, quotedId) {
  const date = fmtDate_(ts);
  let tag = '';

  if (type === 'text') {
    // Reply ต่อข้อความ #เคส → บันทึกเป็นความคืบหน้าของเคสนั้น (ไม่ต้องพิมพ์ HN ซ้ำ)
    const caseIds = quotedId && !TAGS.case.test(text) ? caseIdsOfThread_(chatId, quotedId) : [];
    if (caseIds.length) {
      tag = 'เคส-ติดตาม';
      const status = isDone_(text) || /^\s*(ปิด|จบ)/.test(text) ? 'ปิด' : 'ติดตาม';
      caseIds.forEach(id => append_('Cases', [ts, date, chatId, name, id, status, text, msgId]));
    } else if (TAGS.census.test(text)) {
      tag = 'ยอดผู้ป่วย';
      parseRecords_(text, KEYS.ward).forEach(r => {
        const ward = pick_(r, KEYS.ward);
        if (!ward) return;
        append_('Census', [ts, date, chatId, name, ward,
          num_(pick_(r, KEYS.admit)), num_(pick_(r, KEYS.discharge)), num_(pick_(r, KEYS.refer)),
          num_(pick_(r, KEYS.death)), num_(pick_(r, KEYS.remain)), pick_(r, KEYS.note)]);
      });
    } else if (TAGS.case.test(text)) {
      tag = 'เคส';
      parseRecords_(text, KEYS.caseId).forEach(r => {
        append_('Cases', [ts, date, chatId, name,
          (pick_(r, KEYS.caseId) || '(ไม่ระบุ)').toUpperCase(),
          normStatus_(pick_(r, KEYS.status)), pick_(r, KEYS.detail), msgId]);
      });
    } else if (TAGS.incident.test(text)) {
      tag = 'ผิดปกติ';
      const recs = parseRecords_(text, KEYS.event);
      if (!recs.length) recs.push({});
      recs.forEach(r => {
        const event = pick_(r, KEYS.event) || stripTag_(text, TAGS.incident);
        append_('Incidents', [ts, date, chatId, name,
          normSeverity_(pick_(r, KEYS.severity)), event, pick_(r, KEYS.action), 'แท็ก', msgId]);
      });
    } else if (parseDeptReport_(text, date)) {
      tag = 'รายงานแผนก';
      const rep = parseDeptReport_(text, date);
      const base = [ts, rep.date, chatId, name, rep.dept, rep.unit, rep.total];
      if (!rep.groups.length) append_('Dept', base.concat(['', '', '', rep.close]));
      rep.groups.forEach(g => {
        append_('Dept', base.concat([g.name, '', g.count, rep.close]));
        g.items.forEach(it => append_('Dept', base.concat([g.name, it.name, it.count, rep.close])));
      });
    } else if (!quotedId && hasIncidentKeyword_(text)) {   // Reply ไม่นับซ้ำเป็นเหตุการณ์ใหม่
      tag = 'คำสำคัญ';
      append_('Incidents', [ts, date, chatId, name, 'ตรวจสอบ', text, '', 'คำสำคัญ', msgId]);
    }
  }
  return tag;
}

/**
 * ประมวลผลข้อความเก่าทั้งหมดใหม่ (รันเองจากหน้า Apps Script ครั้งเดียวหลังอัปเดตโค้ด)
 * ใช้เมื่อมีรายงานที่ส่งก่อนอัปเดตโค้ดแล้วไม่ถูกนับ — ข้อความในแท็บ Messages จะไม่ถูกลบ
 */
function reprocessAll() {
  const ss = ss_();
  setupSheetsOnly_();
  const targets = ['Census', 'Cases', 'Incidents', 'Dept'];
  targets.forEach(n => {
    const sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  });
  const msgSh = ss.getSheetByName('Messages');
  const rows = readRows_('Messages');
  BUFFER = {};
  const tags = rows.map(r => {
    const ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
    return [extract_(String(r[2]), r[4], r[5], String(r[6]), ts, String(r[8] || ''), String(r[9] || ''))];
  });
  const buf = BUFFER;
  BUFFER = null;
  Object.keys(buf).forEach(n => {
    const data = buf[n];
    if (!data.length) return;
    append_(n, data[0]);                       // สร้างชีตถ้ายังไม่มี
    if (data.length > 1) {
      const sh = ss.getSheetByName(n);
      sh.getRange(sh.getLastRow() + 1, 1, data.length - 1, data[0].length).setValues(data.slice(1));
    }
  });
  if (rows.length) msgSh.getRange(2, 8, tags.length, 1).setValues(tags);
  const n = tags.filter(t => t[0] === 'รายงานแผนก').length;
  Logger.log('ประมวลผลใหม่ ' + rows.length + ' ข้อความ พบรายงานแผนก ' + n + ' ฉบับ');
}
var BUFFER = null;   // ใช้ตอน reprocessAll เพื่อเขียนชีตทีเดียว

/**
 * อ่านรายงานแบบที่ทีมพิมพ์อยู่แล้ว เช่น
 *   แผนกอายุรกรรม / วันเสาร์ ที่ 19/ 09/ 69 / OPD1 / ยอด Total 78 case
 *   #ผู้ป่วยอายุรกรรม 69 Case / - เป็นนัด 26 Case / ... / ปิดแผนก 20.00น.
 * คืนค่า null ถ้าข้อความไม่ใช่รายงานรูปแบบนี้
 */
function parseDeptReport_(text, fallbackDate) {
  const rep = { dept: '', unit: '', date: fallbackDate, total: '', close: '', groups: [] };
  const COUNT = '(\\d[\\d,]*)\\s*(?:case|cases|ราย|คน)?';
  // บรรทัดกลุ่มต้องมีหน่วยนับ (case/ราย/คน), ขึ้นต้นด้วย # หรืออยู่หลังบรรทัดยอดรวม
  // เพื่อไม่ให้บรรทัดหัวรายงานอย่าง "OPD 1" ถูกนับเป็นกลุ่ม
  const reGroup = /^(.+?)\s+(\d[\d,]*)\s*(case|cases|ราย|คน)?\s*$/i;
  const reItem = new RegExp('^[-•*]\\s*(.+?)\\s+' + COUNT + '\\b', 'i');
  let cur = null, hasItem = false;

  String(text).split(/\r?\n/).forEach(raw => {
    const hash = /^\s*#/.test(raw);
    const line = raw.replace(/^\s*#/, '').replace(/\s+/g, ' ').trim();
    if (!line) return;
    let m;
    if ((m = line.match(/^ปิด(?:แผนก)?\s*(.*)$/))) { rep.close = m[1]; return; }
    if ((m = line.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2,4})/)) && !cur) {
      let y = Number(m[3]);
      if (y < 100) y += 2500;           // ปี พ.ศ. แบบย่อ เช่น 69 → 2569
      if (y > 2400) y -= 543;           // พ.ศ. → ค.ศ.
      rep.date = y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
      return;
    }
    if ((m = line.match(/total\s*[:=]?\s*(\d[\d,]*)/i)) || (m = line.match(/^ยอด(?:รวม)?\s*[:=]?\s*(\d[\d,]*)/))) {
      rep.total = num_(m[1]); return;
    }
    if (line.indexOf(':') < 0 && (m = line.match(reItem))) {
      if (!cur) { cur = { name: '(ทั่วไป)', count: '', items: [] }; rep.groups.push(cur); }
      cur.items.push({ name: m[1].trim(), count: num_(m[2]) });
      hasItem = true;
      return;
    }
    if (line.indexOf(':') < 0 && (m = line.match(reGroup)) && (m[3] || hash || rep.total !== '')) {
      cur = { name: m[1].trim(), count: num_(m[2]), items: [] };
      rep.groups.push(cur);
      return;
    }
    if (!cur) {
      if (!rep.dept && /^แผนก/.test(line)) rep.dept = line;
      else if (!rep.unit && line.length <= 30) rep.unit = line;
    }
  });

  const ok = rep.total !== '' || (rep.groups.length && hasItem);
  if (!ok) return null;
  // หน่วย: "OPD 1" / "opd1" → "OPD1"; ถ้าไม่มีบรรทัดหน่วย ลองหาจากบรรทัดแผนก
  const reCode = /(OPD|IPD|ER|ICU|Ward)\s*\d*[A-Za-z]?(?![A-Za-z])/i;
  const code = rep.unit.match(reCode) || rep.dept.match(reCode);
  if (code) {
    rep.dept = rep.dept.replace(code[0], '').trim();
    rep.unit = code[0].replace(/\s+/g, '').toUpperCase();
  } else if (rep.dept && rep.unit.indexOf(rep.dept) === 0) {
    rep.unit = rep.unit.slice(rep.dept.length).trim();
  }
  rep.dept = rep.dept || '(ไม่ระบุแผนก)';
  return rep;
}

/** แยกบรรทัด "หัวข้อ: ค่า" เป็นรายการ ขึ้นรายการใหม่เมื่อเจอ startKey ซ้ำ */
function parseRecords_(text, startKeys) {
  const recs = [];
  let cur = null;
  String(text).split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*[-•*]?\s*([^:：#\n]+?)\s*[:：]\s*(.*)$/);
    if (!m) return;
    const k = m[1].trim().toLowerCase();
    const v = m[2].trim();
    if (!cur || (startKeys.includes(k) && startKeys.some(s => cur[s] !== undefined))) {
      cur = {};
      recs.push(cur);
    }
    cur[k] = v;
  });
  return recs;
}

function pick_(r, keys) {
  for (const k of keys) if (r[k] !== undefined && r[k] !== '') return r[k];
  return '';
}

function num_(v) {
  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

function normStatus_(s) {
  s = String(s).toLowerCase();
  if (/ปิด|จบ|หาย|จำหน่าย|close|done/.test(s)) return 'ปิด';
  if (/ใหม่|new/.test(s)) return 'ใหม่';
  return 'ติดตาม';
}

function normSeverity_(s) {
  s = String(s).toLowerCase();
  if (/สูง|รุนแรง|high|severe/.test(s)) return 'สูง';
  if (/กลาง|ปานกลาง|medium|moderate/.test(s)) return 'กลาง';
  if (/ต่ำ|น้อย|low|minor/.test(s)) return 'ต่ำ';
  return 'ไม่ระบุ';
}

function hasIncidentKeyword_(text) {
  const t = text.toLowerCase();
  return CONFIG.INCIDENT_KEYWORDS.some(k => t.includes(k.toLowerCase()));
}

function stripTag_(text, re) {
  return String(text).replace(re, '').replace(/\s+/g, ' ').trim();
}

/******************** สร้างสรุป ********************/
function buildSummary_(chatId, date) {
  const rows = name => readRows_(name).filter(r => String(r[2]) === String(chatId));
  const today = r => dateStr_(r[1]) === date;

  const msgs = rows('Messages').filter(today);
  const people = new Set(msgs.map(r => r[4]));
  const out = [];
  out.push('สรุปรายงานประจำวัน ' + thaiDate_(date));
  out.push('ข้อความทั้งหมด ' + msgs.length + ' ข้อความ จาก ' + people.size + ' คน');

  // --- รายงานแผนก (รูปแบบที่ทีมพิมพ์อยู่แล้ว): ใช้ฉบับล่าสุดของแต่ละแผนก/หน่วย ---
  const deptRows = rows('Dept').filter(today);
  const lastTs = {};
  deptRows.forEach(r => {
    const k = r[4] + '|' + r[5], t = new Date(r[0]).getTime();
    if (!(k in lastTs) || t >= lastTs[k]) lastTs[k] = t;
  });
  const deptKeys = Object.keys(lastTs);
  let grand = 0;
  deptKeys.forEach(k => {
    const rs = deptRows.filter(r => r[4] + '|' + r[5] === k && new Date(r[0]).getTime() === lastTs[k]);
    const h = rs[0];
    out.push('', '【' + h[4] + (h[5] ? ' – ' + h[5] : '') + '】' + (h[10] ? ' ปิดแผนก ' + h[10] : ''));
    if (h[6] !== '') { out.push('ยอดรวม ' + h[6] + ' ราย'); grand += Number(h[6]) || 0; }
    let groupSum = 0;
    rs.filter(r => r[7] && !r[8]).forEach(g => {
      groupSum += Number(g[9]) || 0;
      const items = rs.filter(r => r[7] === g[7] && r[8]).map(r => r[8] + ' ' + r[9]);
      const label = g[7] === '(ทั่วไป)' ? '' : g[7] + ' ' + g[9] + (items.length ? ': ' : '');
      out.push('• ' + label + items.join(' | '));
    });
    const catD = catLine_(rs.filter(r => r[7] && !r[8]).map(r => [r[7], r[9]])
      .concat(rs.filter(r => r[7] === '(ทั่วไป)' && r[8]).map(r => [r[7], r[9]])));
    if (catD) out.push('แยกประเภท: ' + catD);
    if (h[6] !== '' && groupSum && groupSum !== Number(h[6])) {
      out.push('(รวมกลุ่มย่อย ' + groupSum + ' จากยอดรวม ' + h[6] + ')');
    }
  });
  if (deptKeys.length > 1) out.push('', 'รวมทุกหน่วย: ' + grand + ' ราย');

  // --- ยอดผู้ป่วยแบบแท็ก #ยอดผู้ป่วย: ใช้รายงานล่าสุดของแต่ละวอร์ดในวันนั้น ---
  const latest = {};
  rows('Census').filter(today).forEach(r => { latest[String(r[4]).trim()] = r; });
  const wards = Object.keys(latest);
  if (!wards.length && !deptKeys.length) {
    out.push('', '【ยอดผู้ป่วย】', '- ยังไม่มีการรายงานยอด');
  }
  if (wards.length) {
    out.push('', '【ยอดผู้ป่วย】 (' + wards.length + ' วอร์ด)');
    const sum = [0, 0, 0, 0, 0];
    wards.forEach(w => {
      const r = latest[w];
      for (let i = 0; i < 5; i++) sum[i] += Number(r[5 + i]) || 0;
      out.push('• ' + w + ': รับ ' + r[5] + ' | จำหน่าย ' + r[6] + ' | ส่งต่อ ' + r[7] +
        (Number(r[8]) ? ' | เสียชีวิต ' + r[8] : '') + ' | คงเหลือ ' + r[9] +
        (r[10] ? ' (' + r[10] + ')' : ''));
    });
    out.push('รวม: รับใหม่ ' + sum[0] + ' | จำหน่าย ' + sum[1] + ' | ส่งต่อ ' + sum[2] +
      ' | เสียชีวิต ' + sum[3] + ' | คงเหลือ ' + sum[4]);
  }
  const missing = CONFIG.EXPECTED_WARDS.filter(w => !wards.includes(w));
  if (missing.length) out.push('ยังไม่ส่งยอด: ' + missing.join(', '));

  // --- ติดตามเคส ---
  const cases = rows('Cases').filter(r => dateStr_(r[1]) <= date);
  const firstSeen = {}, last = {};
  cases.forEach(r => {
    const id = r[4], d = dateStr_(r[1]);
    if (!firstSeen[id] || d < firstSeen[id]) firstSeen[id] = d;
    last[id] = r;
  });
  const todayCases = cases.filter(today);
  const ids = new Set(todayCases.map(r => r[4]));
  let nNew = 0, nUpd = 0, nClosed = 0;
  ids.forEach(id => {
    if (last[id][5] === 'ปิด' && dateStr_(last[id][1]) === date) nClosed++;
    else if (firstSeen[id] === date) nNew++;
    else nUpd++;
  });
  const open = Object.keys(last).filter(id => last[id][5] !== 'ปิด');
  if (cases.length) {             // แสดงเฉพาะเมื่อมีการใช้ #เคส
    out.push('', '【การติดตามเคส】');
    out.push('วันนี้: ใหม่ ' + nNew + ' | อัปเดต ' + nUpd + ' | ปิด ' + nClosed);
    out.push('เคสที่ยังเปิดอยู่: ' + open.length);
    open.slice(0, CONFIG.MAX_OPEN_CASES).forEach(id => {
      const r = last[id];
      out.push('• ' + id + ' – ' + r[5] + (r[6] ? ' – ' + r[6] : '') +
        ' (' + shortDate_(r[1]) + ' ' + r[3] + ')');
    });
    if (open.length > CONFIG.MAX_OPEN_CASES) {
      out.push('...และอีก ' + (open.length - CONFIG.MAX_OPEN_CASES) + ' เคส (ดูในชีต Cases)');
    }
  }

  // --- งานติดตาม (Pre fax / Sleep test) ---
  TRACKERS.forEach(tr => {
    const items = trackerItems_(chatId, tr, date, date);
    if (!items.length) return;
    out.push('', '【' + tr.name + '】 ' + stageCounts_(tr, items, date === fmtDate_(new Date()) ? 'วันนี้' : shortDate_(date)));
  });

  // --- เหตุการณ์ผิดปกติ ---
  const inc = rows('Incidents').filter(today);
  const tagged = inc.filter(r => r[7] === 'แท็ก');
  const flagged = inc.filter(r => r[7] === 'คำสำคัญ');
  const rank = { 'สูง': 0, 'กลาง': 1, 'ต่ำ': 2, 'ไม่ระบุ': 3 };
  tagged.sort((a, b) => rank[a[4]] - rank[b[4]]);
  out.push('', '【เหตุการณ์ผิดปกติ】 ' + tagged.length + ' รายการ');
  if (!tagged.length) out.push('- ไม่มีการรายงาน');
  const th = tagged.length ? threadIndex_(chatId) : null;
  tagged.forEach(r => {
    out.push('• [' + r[4] + '] ' + r[5] + (r[6] ? ' → ' + r[6] : '') +
      ' (' + r[3] + ' ' + fmtTime_(r[0]) + ')');
    const t = r[8] && th.byRoot[String(r[8])];
    if (t) t.replies.slice(-5).forEach(x => out.push('   ↳ ' + fmtTime_(x[0]) + ' ' + x[4] + ': ' + clip_(x[6], 80)));
  });
  if (flagged.length) {
    out.push('ข้อความที่อาจเกี่ยวข้อง (ควรตรวจสอบ):');
    flagged.forEach(r => out.push('• ' + fmtTime_(r[0]) + ' ' + r[3] + ': ' + clip_(r[5], 120)));
  }

  let text = out.join('\n');
  if (text.length > CONFIG.MAX_LEN) text = text.slice(0, CONFIG.MAX_LEN - 40) + '\n...(ตัดทอน ดูฉบับเต็มในชีต)';
  return text;
}

/** เรียกโดย trigger ทุกวัน: บันทึกสรุปลงชีต + ส่งอีเมล/LINE ตามที่ตั้งค่า */
function dailySummary() {
  const date = fmtDate_(new Date());
  const chats = new Set(readRows_('Messages').filter(r => dateStr_(r[1]) === date).map(r => String(r[2])));
  const email = prop_('SUMMARY_EMAIL');
  chats.forEach(chatId => {
    if (!isAllowed_(chatId)) return;
    const text = buildSummary_(chatId, date);
    append_('Summary', [date, chatId, text, new Date()]);
    if (email) MailApp.sendEmail(email, 'สรุปรายงานประจำวัน ' + thaiDate_(date), text);
    if (CONFIG.AUTO_PUSH) pushText_(chatId, text);
  });
}

/******************** คำสั่งสรุปตามต้องการ ********************/
/**
 * รูปแบบคำสั่ง (พิมพ์ในกลุ่ม):
 *   สรุป | สรุปวันนี้ | สรุปเมื่อวาน | สรุปสัปดาห์ | สรุปเดือน | สรุปเดือนที่แล้ว
 *   สรุป 18/09/69 | สรุป 1/09/69-15/09/69
 *   สรุป <คำค้น> [ช่วงเวลา]   เช่น  สรุป Admit เดือน, สรุป จิตเวช สัปดาห์, สรุป แพ้ยา 1/09-19/09
 *   คำสั่ง  → แสดงวิธีใช้
 * คืนค่า null ถ้าไม่ใช่คำสั่ง (เพื่อไม่ให้บอทตอบข้อความคุยทั่วไป)
 */
function parseCommand_(text, today) {
  const t = String(text).trim().replace(/\s+/g, ' ');
  if (t.indexOf('\n') >= 0 || t.length > 60) return null;
  if (CONFIG.HELP_WORDS.some(w => t.toLowerCase() === w)) return { help: true };
  if (t.toLowerCase() === '/summary') return { from: today, to: today, kw: '' };
  const W = CONFIG.SUMMARY_WORD;
  if (t.indexOf(W) !== 0) return null;
  let rest = t.slice(W.length);

  const PERIODS = [
    [/^\s*วันนี้/, () => [today, today]],
    [/^\s*เมื่อวาน/, () => [addDays_(today, -1), addDays_(today, -1)]],
    [/^\s*(สัปดาห์นี้|สัปดาห์|อาทิตย์นี้|อาทิตย์|7\s?วัน)/, () => [addDays_(today, -6), today]],
    [/^\s*(เดือนที่แล้ว|เดือนก่อน)/, () => {
      const end = addDays_(today.slice(0, 8) + '01', -1);
      return [end.slice(0, 8) + '01', end];
    }],
    [/^\s*(เดือนนี้|เดือน|30\s?วัน)/, () => [today.slice(0, 8) + '01', today]],
  ];
  let from = null, to = null;
  // ชื่อเดือน เช่น "เดือนกรกฎาคม 2569", "ก.ค. 69", "กรกฎา"
  const mm = rest.match(MONTH_RE);
  if (mm) {
    const attached = rest && !/^\s/.test(rest);
    [from, to] = monthRange_(mm, today);
    rest = rest.replace(mm[0], ' ');
    if (attached && rest.trim()) return null;   // "สรุปว่า...กรกฎาคม" = คุยทั่วไป
  } else if (rest && !/^\s/.test(rest)) {
    // คำช่วงเวลาที่ติดกับคำว่า "สรุป" เช่น "สรุปสัปดาห์"
    const p = PERIODS.find(p => p[0].test(rest));
    if (!p) return null;                    // เช่น "สรุปว่า..." = คุยทั่วไป ไม่ใช่คำสั่ง
    [from, to] = p[1]();
    rest = rest.replace(p[0], '');
  }
  rest = ' ' + rest.trim() + ' ';

  // ช่วงวันที่ 1/09/69-15/09/69
  const D = '(\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|\\d{4}-\\d{2}-\\d{2})';
  let m = rest.match(new RegExp(D + '\\s*(?:-|–|ถึง)\\s*' + D));
  if (m) {
    from = parseDateToken_(m[1], today); to = parseDateToken_(m[2], today);
    rest = rest.replace(m[0], ' ');
  } else if ((m = rest.match(new RegExp('\\s' + D + '\\s')))) {
    from = to = parseDateToken_(m[1], today);
    rest = rest.replace(m[0], ' ');
  }
  // คำช่วงเวลาที่อยู่ท้ายคำค้น เช่น "สรุป Admit เดือน"
  if (!from) {
    for (const p of PERIODS) {
      const re = new RegExp('\\s' + p[0].source.replace('^\\s*', '') + '\\s*$');
      if (re.test(rest)) { [from, to] = p[1](); rest = rest.replace(re, ' '); break; }
    }
  }
  if (!from || !to) { from = today; to = today; }
  if (from > to) { const x = from; from = to; to = x; }
  return { from, to, kw: rest.trim() };
}

const MONTHS = [
  'ม(?:กรา(?:คม)?|\\.ค\\.)', 'ก(?:ุมภา(?:พันธ์)?|\\.พ\\.)', 'มี(?:นา(?:คม)?|\\.ค\\.)',
  'เม(?:ษา(?:ยน)?|\\.ย\\.)', 'พ(?:ฤษภา(?:คม)?|\\.ค\\.)', 'มิ(?:ถุนา(?:ยน)?|\\.ย\\.)',
  'ก(?:รก[ฎฏ]า(?:คม)?|\\.ค\\.)', 'ส(?:ิงหา(?:คม)?|\\.ค\\.)', 'ก(?:ันยา(?:ยน)?|\\.ย\\.)',
  'ต(?:ุลา(?:คม)?|\\.ค\\.)', 'พ(?:ฤศจิกา(?:ยน)?|\\.ย\\.)', 'ธ(?:ันวา(?:คม)?|\\.ค\\.)',
];
const MONTH_RE = new RegExp('(?:เดือน\\s*)?(' + MONTHS.map(m => '(' + m + ')').join('|') +
  ')\\s*(?:(?:พ\\.ศ\\.|ปี)\\s*)?(\\d{4}|\\d{2}(?!\\d))?');

/** แปลงผลจับชื่อเดือนเป็นช่วงวันที่ [วันแรก, วันสุดท้าย] */
function monthRange_(mm, today) {
  const idx = MONTHS.findIndex((_, i) => mm[i + 2] !== undefined);   // เดือนที่ตรง (0-11)
  let y, yr = mm[MONTHS.length + 2];
  if (yr) {
    y = Number(yr);
    if (y < 100) y += 2500;
    if (y > 2400) y -= 543;
  } else {
    y = Number(today.slice(0, 4));
    if (idx + 1 > Number(today.slice(5, 7))) y -= 1;   // ยังไม่ถึงเดือนนั้น → ปีที่แล้ว
  }
  const from = y + '-' + ('0' + (idx + 1)).slice(-2) + '-01';
  const next = idx === 11 ? (y + 1) + '-01-01' : y + '-' + ('0' + (idx + 2)).slice(-2) + '-01';
  return [from, addDays_(next, -1)];
}

function runCommand_(chatId, c) {
  if (c.help) return helpText_();
  const days = dayCount_(c.from, c.to);
  if (days > CONFIG.MAX_RANGE_DAYS) return 'ช่วงวันที่ยาวเกินไป (สูงสุด ' + CONFIG.MAX_RANGE_DAYS + ' วัน)';
  if (c.kw) return buildKeywordSummary_(chatId, c.kw, c.from, c.to);
  if (c.from === c.to) return buildSummary_(chatId, c.from);
  return buildRangeSummary_(chatId, c.from, c.to);
}

function helpText_() {
  return [
    'คำสั่งที่ใช้ได้',
    '',
    'สรุป – สรุปวันนี้',
    'สรุปเมื่อวาน',
    'สรุปสัปดาห์ – 7 วันล่าสุด',
    'สรุปเดือน – ตั้งแต่วันที่ 1 ของเดือนนี้',
    'สรุปเดือนที่แล้ว',
    'สรุป 18/09/69 – วันที่ระบุ',
    'สรุป 1/09/69-15/09/69 – ช่วงวันที่',
    'สรุปเดือนกรกฎาคม 2569 – ทั้งเดือนที่ระบุ',
    '',
    'สรุปเฉพาะเรื่อง: สรุป <คำ> <ช่วงเวลา>',
    'เช่น  สรุป Admit เดือน',
    '        สรุป จิตเวช สัปดาห์',
    '        สรุป แพ้ยา 1/09/69-19/09/69',
    '        สรุป ผู้สูงอายุ เดือนกรกฎาคม 2569',
    '',
    'เช็คลิสต์ – แสดงเช็คลิสต์ประจำวัน กดติ๊กรายการที่ทำแล้ว',
    '',
    'งานติดตาม (การ์ด 1 ใบต่อ 1 เคส)',
    'สรุป prefax – Pre fax / รอประกันตอบกลับ / ตอบกลับ-อนุมัติ / OR แล้ว',
    'สรุป sleep test – นัดทำ / ทำแล้ว',
  ].join('\n');
}

/** รายงานแผนก: เอาฉบับล่าสุดของแต่ละหน่วยในแต่ละวัน */
function deptReports_(chatId, from, to) {
  const rows = readRows_('Dept').filter(r => String(r[2]) === String(chatId) &&
    dateStr_(r[1]) >= from && dateStr_(r[1]) <= to);
  const lastTs = {};
  rows.forEach(r => {
    const k = r[4] + '|' + r[5] + '|' + dateStr_(r[1]), t = new Date(r[0]).getTime();
    if (!(k in lastTs) || t > lastTs[k]) lastTs[k] = t;
  });
  return rows.filter(r => new Date(r[0]).getTime() === lastTs[r[4] + '|' + r[5] + '|' + dateStr_(r[1])]);
}

function buildRangeSummary_(chatId, from, to) {
  const days = dayCount_(from, to);
  const out = ['สรุป ' + thaiDate_(from) + ' – ' + thaiDate_(to) + ' (' + days + ' วัน)'];
  const inRange = r => dateStr_(r[1]) >= from && dateStr_(r[1]) <= to;
  const mine = name => readRows_(name).filter(r => String(r[2]) === String(chatId));

  // รายงานแผนก
  const rows = deptReports_(chatId, from, to);
  const units = {};
  rows.forEach(r => {
    const k = r[4] + (r[5] ? ' – ' + r[5] : '');
    const u = units[k] = units[k] || { daily: {}, groups: {}, order: [], triples: [] };
    const d = dateStr_(r[1]);
    if (r[6] !== '') u.daily[d] = Number(r[6]) || 0;
    if (r[7] && r[7] !== '(ทั่วไป)' && !r[8]) { addTo_(u, r[7], '', r[9]); u.triples.push([r[1], r[7], r[9]]); }
    if (r[8]) {
      addTo_(u, r[7], r[8], r[9]);
      if (r[7] === '(ทั่วไป)') u.triples.push([r[1], r[7], r[9]]);   // รายการที่ไม่มีบรรทัดกลุ่ม
    }
  });
  Object.keys(units).forEach(k => {
    const u = units[k], ds = Object.keys(u.daily).sort();
    const sum = ds.reduce((a, d) => a + u.daily[d], 0);
    out.push('', '【' + k + '】 มีรายงาน ' + ds.length + '/' + days + ' วัน');
    if (ds.length) {
      const max = ds.reduce((a, d) => (u.daily[d] > u.daily[a] ? d : a), ds[0]);
      out.push('ยอดรวม ' + sum + ' ราย | เฉลี่ย ' + round1_(sum / ds.length) + '/วัน | สูงสุด ' +
        u.daily[max] + ' (' + shortDate_(max) + ')');
    }
    u.order.forEach(g => {
      const G = u.groups[g];
      const items = G.itemOrder.map(i => i + ' ' + G.items[i]);
      const label = g === '(ทั่วไป)' ? '' : g + (G.total !== null ? ' ' + G.total : '') + (items.length ? ': ' : '');
      out.push('• ' + label + items.join(' | '));
    });
    const catR = catLine_(u.order.map(g => [g, u.groups[g].total !== null ? u.groups[g].total :
      u.groups[g].itemOrder.reduce((a, i) => a + u.groups[g].items[i], 0)]));
    if (catR) out.push('แยกประเภท: ' + catR);
    if (ds.length && days <= 31) {
      out.push('รายวัน (ยอดรวม): ' + ds.map(d => shortDate_(d) + '=' + u.daily[d]).join(', '));
      const dl = dailyCatLine_(u.triples);
      if (dl) out.push(dl);
    }
    const missing = listDays_(from, to).filter(d => !(d in u.daily));
    if (missing.length && missing.length <= 10) out.push('ไม่มีรายงาน: ' + missing.map(shortDate_).join(', '));
  });

  // ยอดผู้ป่วยแบบ #ยอดผู้ป่วย
  const census = {};
  mine('Census').filter(inRange).forEach(r => { census[r[4] + '|' + dateStr_(r[1])] = r; });
  const cRows = Object.keys(census).map(k => census[k]);
  if (cRows.length) {
    const s = [0, 0, 0, 0];
    cRows.forEach(r => { for (let i = 0; i < 4; i++) s[i] += Number(r[5 + i]) || 0; });
    out.push('', '【ยอดผู้ป่วย (#ยอดผู้ป่วย)】',
      'รับใหม่ ' + s[0] + ' | จำหน่าย ' + s[1] + ' | ส่งต่อ ' + s[2] + ' | เสียชีวิต ' + s[3]);
  }
  if (!rows.length && !cRows.length) out.push('', '- ไม่มีรายงานยอดในช่วงนี้');

  // เคส
  const cases = mine('Cases').filter(r => dateStr_(r[1]) <= to);
  if (cases.length) {
    const first = {}, last = {};
    cases.forEach(r => { if (!(r[4] in first)) first[r[4]] = dateStr_(r[1]); last[r[4]] = r; });
    const ids = Object.keys(last);
    const nNew = ids.filter(id => first[id] >= from).length;
    const nClosed = ids.filter(id => last[id][5] === 'ปิด' && dateStr_(last[id][1]) >= from).length;
    const open = ids.filter(id => last[id][5] !== 'ปิด').length;
    out.push('', '【การติดตามเคส】', 'เคสใหม่ ' + nNew + ' | ปิด ' + nClosed + ' | ยังเปิดอยู่ ' + open);
  }

  // เหตุการณ์ผิดปกติ
  const inc = mine('Incidents').filter(inRange);
  const tagged = inc.filter(r => r[7] === 'แท็ก');
  const flagged = inc.filter(r => r[7] === 'คำสำคัญ');
  out.push('', '【เหตุการณ์ผิดปกติ】 ' + tagged.length + ' รายการ' +
    (flagged.length ? ' (+ข้อความที่ควรตรวจสอบ ' + flagged.length + ')' : ''));
  tagged.slice(-15).forEach(r => out.push('• ' + shortDate_(r[1]) + ' [' + r[4] + '] ' + clip_(r[5], 80)));

  return clipMsg_(out.join('\n'));
}

function buildKeywordSummary_(chatId, kw, from, to, noCards) {
  const tr = TRACKERS.find(t => t.keyword.test(kw));
  if (tr) return buildTrackerSummary_(chatId, tr, from, to, noCards);
  const k = norm_(kw);
  const has = s => norm_(s).indexOf(k) >= 0;
  const period = from === to ? thaiDate_(from) : thaiDate_(from) + ' – ' + thaiDate_(to);
  const out = ['สรุป "' + kw + '" ' + period];

  // ตัวเลขจากรายงานแผนก: นับที่ระดับกลุ่มถ้าชื่อกลุ่มตรง ไม่งั้นนับที่รายการย่อย
  const rows = deptReports_(chatId, from, to).filter(r =>
    (!r[8] && r[7] && r[7] !== '(ทั่วไป)' && has(r[7])) || (r[8] && has(r[8]) && !has(r[7])));
  if (rows.length) {
    const byLabel = {}, byUnit = {}, daily = {};
    rows.forEach(r => {
      const n = Number(r[9]) || 0, d = dateStr_(r[1]);
      const label = r[8] ? (r[7] === '(ทั่วไป)' ? r[8] : r[7] + ' › ' + r[8]) : r[7];
      const unit = r[5] || r[4];
      byLabel[label] = (byLabel[label] || 0) + n;
      byUnit[unit] = (byUnit[unit] || 0) + n;
      daily[d] = (daily[d] || 0) + n;
    });
    const ds = Object.keys(daily).sort();
    const sum = ds.reduce((a, d) => a + daily[d], 0);
    out.push('', 'รวม ' + sum + ' ราย' + (ds.length > 1 ? ' | เฉลี่ย ' + round1_(sum / ds.length) + '/วัน (' + ds.length + ' วันที่มีรายงาน)' : ''));
    const catK = catLine_(rows.map(r => [r[7], r[9]]));
    if (catK) out.push('แยกประเภท: ' + catK);
    const unknown = rows.filter(r => catOf_(r[7]) === CAT_UNKNOWN);
    if (unknown.length) {
      const ds2 = unknown.map(r => shortDate_(r[1])).filter((d, i, a) => a.indexOf(d) === i);
      out.push('  (' + CAT_UNKNOWN + ' มาจากรายงานที่ไม่มีบรรทัดกลุ่ม เช่น #ผู้ป่วยอายุรกรรม: ' +
        ds2.slice(0, 8).join(', ') + (ds2.length > 8 ? ' และอีก ' + (ds2.length - 8) + ' วัน' : '') + ')');
    }
    if (Object.keys(byUnit).length > 1) out.push('แยกหน่วย: ' + Object.keys(byUnit).map(u => u + ' ' + byUnit[u]).join(' | '));
    if (Object.keys(byLabel).length > 1 || Object.keys(byLabel)[0] !== kw) {
      out.push('แยกรายการ: ' + Object.keys(byLabel).map(l => l + ' ' + byLabel[l]).join(' | '));
    }
    if (ds.length > 1 && dayCount_(from, to) <= 31) {
      out.push(dailyCatLine_(rows.map(r => [r[1], r[7], r[9]])));
    }
  }

  // เรื่องที่พูดถึงคำนี้ จัดกลุ่มตาม Reply (ไม่นับข้อความรายงานแผนกที่นับไปแล้ว)
  const th = threadIndex_(chatId);
  const match = th.list.filter(t => t.root[7] !== 'รายงานแผนก' &&
    [t.root].concat(t.replies).some(x => has(x[6])));
  const inRange = match.filter(t => dateStr_(t.root[1]) >= from && dateStr_(t.root[1]) <= to);
  const carry = match.filter(t => !t.done && dateStr_(t.root[1]) < from &&
    dateStr_(t.root[1]) >= addDays_(from, -30));
  if (inRange.length || carry.length) {
    const open = inRange.filter(t => !t.done), done = inRange.filter(t => t.done);
    out.push('', 'ทั้งหมด ' + inRange.length + ' เรื่อง | ค้าง ' + open.length + ' | เสร็จ ' + done.length +
      (carry.length ? '\nค้างจากก่อนหน้า ' + carry.length + ' เรื่อง' : ''));
    if (CONFIG.USE_CARDS && !noCards) {
      const items = open.map(t => ({ t, kind: 'open' }))
        .concat(carry.map(t => ({ t, kind: 'carry' })), done.map(t => ({ t, kind: 'done' })));
      const shown = items.slice(0, CONFIG.MAX_CARDS);
      if (items.length > shown.length) out.push('แสดง ' + shown.length + ' เรื่องแรก (ระบุช่วงวันที่ให้แคบลง)');
      out.push('เลื่อนการ์ดด้านล่างไปทางซ้ายเพื่อดูเรื่องถัดไป');
      const msgs = [{ type: 'text', text: clipMsg_(out.join('\n')) }];
      for (let i = 0; i < shown.length; i += 12) {
        msgs.push({
          type: 'flex',
          altText: 'สรุป "' + kw + '" ' + shown.length + ' เรื่อง',
          contents: { type: 'carousel', contents: shown.slice(i, i + 12).map(x => threadCard_(x.t, x.kind)) },
        });
      }
      return { messages: msgs, fallback: buildKeywordSummary_(chatId, kw, from, to, true) };
    }
    let n = 0;
    const show = (title, list, withAge) => {
      if (!list.length) return;
      out.push('', title);
      list.forEach(t => {
        if (++n > CONFIG.MAX_THREADS) return;
        out.push(n + '. ' + clip_(firstLine_(t.root[6]), 60) + ' (' + t.root[4] + ' ' +
          (from === to ? '' : shortDate_(t.root[1]) + ' ') + fmtTime_(t.root[0]) + ')');
        t.replies.slice(-4).forEach(x => out.push('   ↳ ' + (from === to ? '' : shortDate_(x[1]) + ' ') +
          fmtTime_(x[0]) + ' ' + x[4] + ': ' + clip_(x[6], 70)));
        if (!t.replies.length) out.push('   ยังไม่มีการตอบ');
        if (withAge) out.push('   ค้างมา ' + age_(t.root[0]));
      });
    };
    show('【ค้าง】', open, true);
    show('【ค้างจากก่อนหน้า】', carry, true);
    show('【เสร็จ】', done, false);
    if (n > CONFIG.MAX_THREADS) out.push('', '...และอีก ' + (n - CONFIG.MAX_THREADS) + ' เรื่อง (ระบุช่วงวันที่ให้แคบลง)');
  }
  if (!rows.length && !inRange.length && !carry.length) out.push('', 'ไม่พบ "' + kw + '" ในช่วงนี้');
  return clipMsg_(out.join('\n'));
}

/******************** เรื่องที่ Reply ต่อกัน ********************/
/** จัดกลุ่มข้อความตาม Reply: 1 เรื่อง = ข้อความแรก + ทุกข้อความที่ Reply ต่อ (ต่อกันกี่ชั้นก็ได้) */
function threadIndex_(chatId) {
  const rows = readRows_('Messages').filter(r => String(r[2]) === String(chatId) && r[5] === 'text');
  const byId = {};
  rows.forEach(r => { if (r[8]) byId[String(r[8])] = r; });
  const rootOf = r => {
    let cur = r, guard = 0;
    while (cur[9] && byId[String(cur[9])] && guard++ < 100) cur = byId[String(cur[9])];
    return cur;
  };
  const map = new Map(), byRoot = {}, list = [];
  rows.forEach(r => {
    const root = rootOf(r);
    if (!map.has(root)) {
      const t = { root, replies: [], done: false };
      map.set(root, t); list.push(t);
      if (root[8]) byRoot[String(root[8])] = t;
    }
    if (root !== r) {
      const t = map.get(root);
      t.replies.push(r);
      if (isDone_(r[6])) t.done = true;
    }
  });
  return { list, byRoot, byId, rootOf };
}

/******************** งานติดตามแบบมีขั้นตอน ********************/
function stageOfText_(tr, text) {
  const t = String(text).toLowerCase().replace(/\s+/g, ' ');
  for (let i = tr.stages.length - 1; i > 0; i--) {
    const st = tr.stages[i];
    if (st.re.test(st.ignore ? t.replace(st.ignore, ' ') : t)) return i;
  }
  return 0;
}

/** เรื่องทั้งหมดของงานนี้ + ขั้นล่าสุด; งานที่ยังไม่จบแสดงทั้งหมด, งานที่จบแล้วแสดงเฉพาะที่จบในช่วงวันที่ */
function trackerItems_(chatId, tr, from, to) {
  const since = addDays_(to, -CONFIG.TRACK_LOOKBACK_DAYS);
  return threadIndex_(chatId).list
    .filter(t => t.root[7] !== 'รายงานแผนก' && [t.root].concat(t.replies).some(x => tr.keyword.test(x[6])))
    .map(t => {
      let reached = 0, reachedMsg = t.root, closeIdx = -1, closeMsg = null, appt = '';
      [t.root].concat(t.replies).forEach(x => {
        const s = stageOfText_(tr, x[6]);
        if (s > 0 && tr.stages[s].close) { closeIdx = s; closeMsg = x; }
        else if (s > 0 && s >= reached) { reached = s; reachedMsg = x; }
        const d = /นัด/.test(x[6]) && String(x[6]).match(/(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/);
        if (d) appt = d[0].replace(/\s/g, '');
      });
      const closed = closeIdx >= 0;
      return { t, stage: closed ? closeIdx : reached, stageMsg: closed ? closeMsg : reachedMsg, reached, closed, appt };
    })
    .filter(x => {
      const start = dateStr_(x.t.root[1]);
      if (start > to) return false;
      if (!tr.stages[x.stage].end) return start >= since;
      const end = dateStr_(x.stageMsg[1]);
      return end >= from && end <= to;
    })
    .sort((a, b) => a.stage - b.stage ||
      (a.appt && b.appt ? parseDateToken_(a.appt, to).localeCompare(parseDateToken_(b.appt, to)) : 0) ||
      new Date(a.t.root[0]) - new Date(b.t.root[0]));
}

function stageCounts_(tr, items, finalLabel) {
  return tr.stages.map((st, i) => st.label + (st.end ? ' (' + finalLabel + ')' : '') + ' ' +
    items.filter(x => x.stage === i).length).join(' | ');
}

function buildTrackerSummary_(chatId, tr, from, to, noCards) {
  const items = trackerItems_(chatId, tr, from, to);
  const period = from === to ? (to === fmtDate_(new Date()) ? 'วันนี้' : thaiDate_(to)) : thaiDate_(from) + '–' + thaiDate_(to);
  const out = ['ติดตาม ' + tr.name];
  if (!items.length) return out.concat(['', 'ไม่มีเรื่องที่กำลังติดตาม']).join('\n');
  out.push('ยังไม่จบ ' + items.filter(x => !tr.stages[x.stage].end).length + ' เรื่อง', '');
  tr.stages.forEach((st, i) => out.push('• ' + st.label + (st.end ? ' (' + period + ')' : '') + ': ' +
    items.filter(x => x.stage === i).length));

  if (CONFIG.USE_CARDS && !noCards) {
    const shown = items.slice(0, CONFIG.MAX_CARDS);
    if (items.length > shown.length) out.push('', 'แสดง ' + shown.length + ' จาก ' + items.length + ' เรื่อง');
    out.push('', 'เลื่อนการ์ดด้านล่างไปทางซ้ายเพื่อดูเรื่องถัดไป');
    const msgs = [{ type: 'text', text: clipMsg_(out.join('\n')) }];
    for (let i = 0; i < shown.length; i += 12) {
      msgs.push({ type: 'flex', altText: 'ติดตาม ' + tr.name + ' ' + shown.length + ' เรื่อง',
        contents: { type: 'carousel', contents: shown.slice(i, i + 12).map(x => trackerCard_(tr, x)) } });
    }
    return { messages: msgs, fallback: buildTrackerSummary_(chatId, tr, from, to, true) };
  }
  tr.stages.forEach((st, i) => {
    const list = items.filter(x => x.stage === i);
    if (!list.length) return;
    out.push('', '【' + st.label + '】');
    list.forEach((x, n) => {
      out.push((n + 1) + '. ' + clip_(firstLine_(x.t.root[6]), 60) + (x.appt ? ' · นัด ' + x.appt : '') +
        (x.closed ? ' · ปิดหลังขั้น ' + tr.stages[x.reached].label : ''));
      x.t.replies.slice(-3).forEach(r => out.push('   ↳ ' + shortDate_(r[1]) + ' ' + r[4] + ': ' + clip_(r[6], 70)));
    });
  });
  return clipMsg_(out.join('\n'));
}

function trackerCard_(tr, x) {
  const t = x.t, st = tr.stages[x.stage];
  const txt = (text, extra) => Object.assign({ type: 'text', text: String(text || '-'), wrap: true }, extra || {});
  const when = r => shortDate_(r[1]) + ' ' + fmtTime_(r[0]);
  const first = firstLine_(t.root[6]);
  const m = first.match(/HN\s*[:.]?\s*\d+/i) || String(t.root[6]).match(/HN\s*[:.]?\s*\d+/i);
  const hn = m ? m[0].replace(/[\s:.]/g, '').toUpperCase() : '';
  const title = clip_(m ? first.replace(m[0], '').trim() : first, 90);
  const dot = r => { const s = stageOfText_(tr, r[6]); return s > 0 ? tr.stages[s].color : '#BBBBBB'; };

  const body = [];
  if (hn && title) body.push(txt(title, { size: 'sm', weight: 'bold' }));
  if (x.closed) {
    const reason = String(x.stageMsg[6]).replace(/ปิดเคส|ปิดเรื่อง|จบเคส/, '').replace(/^[\s:,-]+/, '').trim();
    body.push(txt('ปิดหลังขั้น: ' + tr.stages[x.reached].label, { size: 'xs', color: '#6B7280', margin: 'sm' }));
    if (reason) body.push(txt('เหตุผล: ' + clip_(reason, 100), { size: 'sm', weight: 'bold', color: '#6B7280', margin: 'xs' }));
  }
  if (tr.showAppointment && x.appt && !x.closed) body.push(txt('วันนัด ' + x.appt, { size: 'md', weight: 'bold', color: st.color, margin: 'sm' }));
  body.push(step_(when(t.root), t.root[4], clip_(t.root[6], 120), '#BBBBBB'));
  const reps = t.replies.slice(-6);
  if (t.replies.length > reps.length) body.push(txt('... ' + (t.replies.length - reps.length) + ' ข้อความก่อนหน้า', { size: 'xxs', color: '#999999', margin: 'sm' }));
  reps.forEach(r => body.push(step_(when(r), r[4], clip_(r[6], 120), dot(r))));
  if (!t.replies.length) body.push(txt('ยังไม่มีการตอบ', { size: 'sm', color: '#999999', margin: 'md' }));

  // แถบขั้นตอน: ● ขั้นที่ผ่านแล้ว / ○ ขั้นที่ยังไม่ถึง
  const progress = tr.stages.filter(s => !s.close).map((s, i) => (i <= x.reached ? '●' : '○')).join(' ') +
    (x.closed ? '  ✕ ปิดเคส' : '');
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: st.color, paddingAll: '12px',
      contents: [
        txt(tr.name + ' · ' + st.label, { color: '#FFFFFF', size: 'xs', weight: 'bold' }),
        txt(hn || clip_(first, 30), { color: '#FFFFFF', size: 'lg', weight: 'bold', margin: 'xs' }),
        txt(progress, { color: '#FFFFFF', size: 'xs', margin: 'xs' }),
      ],
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '14px', contents: body, action: jumpAction_(t) },
    footer: cardFooter_(t),
  };
}

/** การ์ด (LINE Flex bubble) 1 ใบต่อ 1 เรื่อง: สีหัวการ์ดบอกสถานะ, ด้านในเป็นไทม์ไลน์ของ Reply */
function threadCard_(t, kind) {
  const STYLE = {
    open: { color: '#E5484D', label: 'ค้าง' },
    carry: { color: '#E08A00', label: 'ค้างจากก่อนหน้า' },
    done: { color: '#06C755', label: 'เสร็จ' },
  }[kind];
  const txt = (text, extra) => Object.assign({ type: 'text', text: String(text || '-'), wrap: true }, extra || {});
  const when = r => shortDate_(r[1]) + ' ' + fmtTime_(r[0]);
  const first = firstLine_(t.root[6]);
  const m = first.match(/HN\s*[:.]?\s*\d+/i) || String(t.root[6]).match(/HN\s*[:.]?\s*\d+/i);
  const hn = m ? m[0].replace(/[\s:.]/g, '').toUpperCase() : '';
  const title = clip_(m ? first.replace(m[0], '').replace(/^(เคส|case)\s*:?\s*/i, '').trim() : first, 90);

  const timeline = [txt('เริ่มเรื่อง', { size: 'xxs', color: '#999999', margin: 'md' }),
    step_(when(t.root), t.root[4], clip_(t.root[6], 120), '#999999')];
  const reps = t.replies.slice(-6);
  if (t.replies.length > reps.length) timeline.push(txt('... ' + (t.replies.length - reps.length) + ' ข้อความก่อนหน้า', { size: 'xxs', color: '#999999', margin: 'sm' }));
  reps.forEach(r => timeline.push(step_(when(r), r[4], clip_(r[6], 120), isDone_(r[6]) ? '#06C755' : STYLE.color)));
  if (!t.replies.length) timeline.push(txt('ยังไม่มีการตอบ', { size: 'sm', color: '#E5484D', margin: 'md', weight: 'bold' }));

  const status = kind === 'done'
    ? 'ใช้เวลา ' + span_(t.root[0], t.replies[t.replies.length - 1][0])
    : age_(t.root[0]);
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: STYLE.color, paddingAll: '12px',
      contents: [
        txt(STYLE.label + ' · ' + status, { color: '#FFFFFF', size: 'xs', weight: 'bold' }),
        txt(hn || clip_(firstLine_(t.root[6]), 30), { color: '#FFFFFF', size: 'lg', weight: 'bold', margin: 'xs' }),
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '14px',
      contents: (hn && title ? [txt(title, { size: 'sm', weight: 'bold' })] : []).concat(timeline),
      action: jumpAction_(t),
    },
    footer: cardFooter_(t),
  };
}

/** ปุ่มท้ายการ์ด: ไปที่ข้อความล่าสุดของเรื่องนี้ */
function jumpAction_(t) {
  const last = t.replies.length ? t.replies[t.replies.length - 1] : t.root;
  return last[8] ? { type: 'postback', label: 'ไปที่ข้อความล่าสุด', data: 'jump=' + last[8] } : undefined;
}
function cardFooter_(t) {
  const c = [{ type: 'text', text: 'ตอบกลับ ' + t.replies.length + ' ข้อความ · โดย ' + String(t.root[4] || '-'),
    size: 'xxs', color: '#999999', align: 'center', wrap: true }];
  const last = t.replies.length ? t.replies[t.replies.length - 1] : t.root;
  if (last[8]) c.unshift({ type: 'button', style: 'link', height: 'sm', action: jumpAction_(t) });
  return { type: 'box', layout: 'vertical', paddingAll: '8px', contents: c };
}

function jumpToMessage_(replyToken, chatId, msgId) {
  const r = readRows_('Messages').find(x => String(x[2]) === String(chatId) && String(x[8]) === msgId);
  if (!r) { replyText_(replyToken, 'ไม่พบข้อความนี้ในบันทึก'); return; }
  const info = 'ข้อความล่าสุด · ' + r[4] + ' ' + shortDate_(r[1]) + ' ' + fmtTime_(r[0]);
  if (r[10]) {
    const ok = replyMessages_(replyToken, [{ type: 'text', quoteToken: String(r[10]),
      text: '↑ แตะที่ข้อความที่อ้างถึงด้านบน เพื่อไปยังตำแหน่งในแชท\n' + info }]);
    if (ok) return;
  }
  // ข้อความเก่า (ก่อนอัปเดตโค้ด) ไม่มี quoteToken → แสดงเนื้อความแทน
  replyText_(replyToken, info + '\n\n' + clip_(r[6], 1000) + '\n\n(ข้อความนี้ส่งก่อนเปิดใช้การลิงก์ จึงพาไปยังตำแหน่งในแชทไม่ได้)');
}

function step_(when, who, text, dot) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md',
    contents: [
      { type: 'box', layout: 'vertical', width: '8px', height: '8px', cornerRadius: '4px', backgroundColor: dot, offsetTop: '5px', contents: [] },
      { type: 'box', layout: 'vertical', flex: 1, contents: [
        { type: 'text', text: String(when) + ' · ' + String(who || '-'), size: 'xxs', color: '#999999' },
        { type: 'text', text: String(text || '-'), size: 'sm', wrap: true },
      ] },
    ],
  };
}

function span_(a, b) {
  const h = Math.max(0, Math.floor((new Date(b) - new Date(a)) / 36e5));
  return h < 1 ? 'ไม่ถึง 1 ชม.' : h < 24 ? h + ' ชม.' : Math.floor(h / 24) + ' วัน';
}

/** ถ้า quotedId อยู่ในเรื่องที่เริ่มด้วย #เคส คืนรหัสเคสของเรื่องนั้น */
function caseIdsOfThread_(chatId, quotedId) {
  const msgs = readRows_('Messages').filter(r => String(r[2]) === String(chatId));
  const byId = {};
  msgs.forEach(r => { if (r[8]) byId[String(r[8])] = r; });
  let cur = byId[quotedId], rootId = quotedId, guard = 0;
  while (cur && guard++ < 100) {
    rootId = String(cur[8]);
    if (!cur[9] || !byId[String(cur[9])]) break;
    cur = byId[String(cur[9])];
  }
  const cases = readRows_('Cases').concat(BUFFER && BUFFER.Cases ? BUFFER.Cases : []);
  const ids = [];
  cases.forEach(r => { if (String(r[7]) === rootId && ids.indexOf(r[4]) < 0) ids.push(r[4]); });
  return ids;
}

function isDone_(text) {
  const t = norm_(text);
  return CONFIG.DONE_WORDS.some(w => t.indexOf(norm_(w)) >= 0);
}
function norm_(s) { return String(s).toLowerCase().replace(/[\s\-_.·]/g, ''); }
function firstLine_(s) {   // หัวเรื่อง: ตัดบรรทัดที่เป็นแท็กล้วน เช่น "#เคส"
  return String(s).split(/\r?\n/).map(x => x.trim()).filter(x => x && !/^#\S*$/.test(x)).join(' ');
}
function age_(ts) {
  const h = Math.floor((Date.now() - new Date(ts).getTime()) / 36e5);
  return h < 24 ? h + ' ชม.' : Math.floor(h / 24) + ' วัน';
}

function addTo_(u, g, item, n) {
  if (!u.groups[g]) { u.groups[g] = { total: null, items: {}, itemOrder: [] }; u.order.push(g); }
  const G = u.groups[g];
  n = Number(n) || 0;
  if (!item) { G.total = (G.total || 0) + n; return; }
  if (!(item in G.items)) { G.items[item] = 0; G.itemOrder.push(item); }
  G.items[item] += n;
}

function parseDateToken_(s, today) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const p = s.split('/');
  let y = p[2] ? Number(p[2]) : Number(today.slice(0, 4));
  if (y < 100) y += 2500;
  if (y > 2400) y -= 543;
  return y + '-' + ('0' + p[1]).slice(-2) + '-' + ('0' + p[0]).slice(-2);
}
function addDays_(s, n) {
  const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayCount_(from, to) {
  return Math.round((new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 864e5) + 1;
}
function listDays_(from, to) {
  const out = []; for (let d = from; d <= to; d = addDays_(d, 1)) out.push(d); return out;
}
function round1_(x) { return Math.round(x * 10) / 10; }
function clipMsg_(text) {
  return text.length > CONFIG.MAX_LEN ? text.slice(0, CONFIG.MAX_LEN - 40) + '\n...(ตัดทอน ดูฉบับเต็มในชีต)' : text;
}

/******************** เช็คลิสต์ประจำวัน ********************/
/**
 * ทุกวันบอทส่งการ์ดเช็คลิสต์เข้ากลุ่ม LINE ตามเวลาเข้าเวร (hour ของแต่ละเวร: 06:00 = NA1, 07:00 = NA2-NA4)
 * เจ้าหน้าที่กดที่รายการเพื่อติ๊กว่าทำแล้ว → บันทึกลงชีต ChecklistLog และบอทตอบการ์ดเวรนั้นที่อัปเดตแล้ว
 * ตั้งค่า: Script property CHECKLIST_CHAT = รหัสกลุ่มที่จะส่ง (ถ้าไม่ตั้ง ใช้ ALLOWED_CHATS ตัวแรก)
 * แก้รายการได้ที่ CHECKLIST ด้านล่าง ถ้าเปลี่ยนชั่วโมง (hour) ต้องแก้ checklistAt6/checklistAt7 ให้ตรงและรัน setupChecklistTrigger()
 */
const CHECKLIST_WORDS = ['เช็คลิสต์', 'เช็คลิส', 'checklist'];
const CHECKLIST_START = '2026-11-01';   // เริ่มส่งตั้งแต่วันที่นี้ (1 พ.ย. 2569) ก่อนหน้านั้นไม่ส่ง
const CHECKLIST = [
  { id: 'NA1', hour: 6, title: 'เวร 6.00น NA1', items: [
    'เปิดไฟ เปิดแอร์',
    'เปิดห้องตรวจ เช็คความพร้อมใช้ทุกจุด',
    'ติดป้ายหน้าห้องตรวจ',
    'เปิดคอมพิวเตอร์ทุกจุด',
    'เตรียมห้อง V/S',
    'เตรียมความพร้อมห้อง 3',
    'EKG, เป่าปอด, รถ Emer วางในจุดพร้อมใช้',
    'เตรียมแฟ้มนัด',
  ] },
  { id: 'NA2', hour: 7, title: 'เวร 7.00น NA2', items: [
    'แลกของ Sterile',
    'เปลี่ยนถุงผ้า',
    'เบิกผ้า',
    'เข้าเคส',
  ] },
  { id: 'NA3', hour: 7, title: 'เวร 7.00น NA3', items: [
    'พิมพ์อัตรากำลัง ประจำคอม ช่วยรับคนไข้',
    'เปิดไฟ เปิดแอร์ เวลา 7.00น',
  ] },
  { id: 'NA4', hour: 7, title: 'เวร 7.00น NA4', items: [
    'ช่วยรับคนไข้ + เข้าเคส',
  ] },
];

function setupChecklistTrigger() {
  const handlers = ['dailyChecklist', 'checklistAt6', 'checklistAt7'];
  ScriptApp.getProjectTriggers()
    .filter(t => handlers.includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  [['checklistAt6', 6], ['checklistAt7', 7]].forEach(([fn, hour]) =>
    ScriptApp.newTrigger(fn).timeBased().atHour(hour).everyDays(1).inTimezone(CONFIG.TZ).create());
}
function checklistAt6() { dailyChecklist(6); }
function checklistAt7() { dailyChecklist(7); }

function checklistChat_() {
  return prop_('CHECKLIST_CHAT') ||
    (prop_('ALLOWED_CHATS') || '').split(',').map(s => s.trim()).filter(String)[0] || '';
}

/** ส่งเช็คลิสต์ของวันนี้เข้ากลุ่ม เฉพาะเวรที่เข้าเวรชั่วโมง hour (ไม่ระบุ = ทุกเวร ใช้ทดสอบมือ) */
function dailyChecklist(hour) {
  const to = checklistChat_();
  const today = fmtDate_(new Date());
  if (hour && today < CHECKLIST_START) return;   // trigger รายวัน: ยังไม่ถึงวันเริ่ม (รันมือแบบไม่ใส่ hour ยังส่งได้)
  if (!to) { console.error('ยังไม่ได้ตั้ง CHECKLIST_CHAT / ALLOWED_CHATS'); return; }
  lineApi_('/v2/bot/message/push', { to, messages: [checklistMessage_(today, null, hour)] });
}

/** ตัวแปรสถานะ: { 'NA1|0': [ชื่อ, เวลา], ... } ของวันที่ระบุ */
function checklistDone_(date) {
  const done = {};
  readRows_('ChecklistLog').forEach(r => {
    if (dateStr_(r[1]) === date) done[r[2] + '|' + (Number(r[3]) - 1)] = [String(r[5]), fmtTime_(r[0])];
  });
  return done;
}

/** การ์ด Flex: ไม่ระบุ roleId = ทุกเวร (carousel), ระบุ = เวรนั้นเวรเดียว; hour = เฉพาะเวรที่เข้าเวรชั่วโมงนั้น */
function checklistMessage_(date, roleId, hour) {
  const done = checklistDone_(date);
  const roles = CHECKLIST.filter(r => (!roleId || r.id === roleId) && (!hour || r.hour === hour));
  const bubbles = roles.map(r => checklistBubble_(r, date, done));
  const total = roles.reduce((n, r) => n + r.items.length, 0);
  const count = Object.keys(done).filter(k => roles.some(r => k.indexOf(r.id + '|') === 0)).length;
  return {
    type: 'flex',
    altText: 'เช็คลิสต์ประจำวัน ' + thaiDate_(date) + ' (' + count + '/' + total + ')',
    contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles },
  };
}

function checklistBubble_(role, date, done) {
  const n = role.items.filter((_, i) => done[role.id + '|' + i]).length;
  const rows = role.items.map((it, i) => {
    const d = done[role.id + '|' + i];
    const text = [{ type: 'text', text: it, wrap: true, size: 'sm',
      color: d ? '#999999' : '#111111', decoration: d ? 'line-through' : 'none' }];
    if (d) text.push({ type: 'text', text: d[0] + (d[1] ? ' · ' + d[1] : ''), size: 'xxs', color: '#999999' });
    return {
      type: 'box', layout: 'horizontal', spacing: 'md', paddingAll: '6px',
      action: { type: 'postback', label: 'ติ๊ก', data: 'ck=' + date + '|' + role.id + '|' + i },
      contents: [
        { type: 'text', text: d ? '☑' : '☐', flex: 0, size: 'lg', color: d ? '#1DB446' : '#555555' },
        { type: 'box', layout: 'vertical', flex: 1, contents: text },
      ],
    };
  });
  return {
    type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: n === role.items.length ? '#1DB446' : '#06C755',
      contents: [
        { type: 'text', text: role.title, weight: 'bold', color: '#FFFFFF' },
        { type: 'text', text: 'เช็คลิสต์ ' + thaiDate_(date), size: 'xs', color: '#FFFFFF' },
      ] },
    body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: rows },
    footer: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: 'ทำแล้ว ' + n + '/' + role.items.length + (n === role.items.length ? ' ✅' : ''),
        size: 'xs', color: '#666666', align: 'center' },
    ] },
  };
}

/** กดติ๊ก: บันทึก (ถ้ายังไม่เคยติ๊ก) แล้วคืนการ์ดเวรนั้นที่อัปเดตแล้ว; ข้อมูลไม่ถูกต้อง = null */
function checklistTick_(src, data) {
  const m = String(data).match(/^ck=(\d{4}-\d{2}-\d{2})\|(\w+)\|(\d+)$/);
  if (!m) return null;
  const role = CHECKLIST.find(r => r.id === m[2]);
  const idx = Number(m[3]);
  if (!role || !role.items[idx]) return null;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (!checklistDone_(m[1])[role.id + '|' + idx]) {
      append_('ChecklistLog', [new Date(), m[1], role.id, idx + 1, role.items[idx], getName_(src), src.userId || '']);
    }
  } finally {
    lock.releaseLock();
  }
  return checklistMessage_(m[1], role.id);
}

/******************** รายงานเคสจาก LINE → ระบบรายงาน daily-report ********************/
/**
 * ข้อความรายงานเคสในกลุ่ม LINE ของ OPD1 → แยกชื่อผู้ป่วย อายุ HN เวลา แพทย์ V/S เหตุการณ์ การแก้ไข
 * แล้วบันทึกเป็น "ร่างเคส" ลงชีต 'เคสจาก LINE' ในไฟล์ Google Sheets ของ daily-report
 * ในฟอร์มรายงานของ OPD1 กด "ดึงเคสจาก LINE" → ช่องต่าง ๆ ถูกกรอกให้ ตรวจแล้วกดบันทึก (บอทไม่เขียนลงรายงานเอง)
 * ข้อความที่นับเป็นรายงานเคส: มีแท็ก #รายงานเคส หรือมีค่า V/S ตั้งแต่ 2 ค่าขึ้นไป
 *   (Reply ต่อข้อความอื่นไม่นับ ยกเว้นมีแท็ก เพื่อไม่ให้การวัด V/S ซ้ำกลายเป็นเคสใหม่)
 * Script Properties: REPORT_SHEET_ID = รหัสไฟล์ Google Sheets ของ daily-report (บัญชีที่ deploy บอทต้องแก้ไขไฟล์นั้นได้)
 *                    CASE_CHAT       = รหัสกลุ่ม LINE ของ OPD1 (พิมพ์อะไรก็ได้ในกลุ่มแล้วดูคอลัมน์ "แชท" ในชีต Messages)
 */
const CASE_DRAFT = {
  UNIT: 'OPD1',
  SHEET: 'เคสจาก LINE',      // ต้องตรงกับ SH_LINE_CASES ใน daily-report
  TAG: /#\s*(รายงานเคส|เคสopd)/i,
  MIN_VITALS: 2,
  REPLY: true,               // ตอบยืนยันในกลุ่ม (ใช้ reply ไม่เสียโควตา)
};
const CASE_KEYS = ['patient', 'age', 'hn', 'time', 'doctor', 'bp', 'pr', 'rr', 'temp', 'spo2', 'o2mode', 'o2flow', 'detail', 'action'];
const CASE_SHEET_HEADER = ['messageId', 'เวลาส่ง', 'วันที่', 'หน่วยงาน', 'ผู้ส่ง (LINE)', 'ชื่อ-สกุลผู้ป่วย', 'อายุ', 'HN', 'เวลามารับบริการ',
  'แพทย์เจ้าของไข้', 'BP (mmHg)', 'PR (/min)', 'RR (/min)', 'T (°C)', 'O2 sat (%)', 'O2', 'O2 ที่ให้', 'รายละเอียด', 'การแก้ไขเบื้องต้น',
  'ข้อความต้นฉบับ', 'สถานะ', 'นำเข้าเมื่อ'];
const CASE_LABELS = {
  detail: /^(?:เหตุการณ์|รายละเอียด|อาการ(?:สำคัญ)?|ปัญหา|cc)$/i,
  action: /^(?:แก้ไข|การแก้ไข(?:เบื้องต้น)?|การจัดการ|(?:ให้)?การพยาบาล|management|plan)$/i,
};

/** ข้อความในกลุ่ม OPD1 ที่เป็นรายงานเคส → บันทึกร่างเคสแล้วคืนข้อความตอบกลับ (ไม่ใช่รายงานเคส = null) */
function caseDraft_(chatId, name, text, ts, msgId, isReply) {
  if (!msgId || !prop_('REPORT_SHEET_ID') || chatId !== prop_('CASE_CHAT')) return null;
  const tagged = CASE_DRAFT.TAG.test(text);
  if (isReply && !tagged) return null;
  const c = parseCaseReport_(text, ts);
  const nVital = ['bp', 'pr', 'rr', 'temp', 'spo2'].filter(k => c[k]).length;
  if (!tagged && nVital < CASE_DRAFT.MIN_VITALS) return null;

  const sh = caseSheet_();
  if (sh.getLastRow() > 1 && sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(msgId).matchEntireCell(true).findNext()) return null; // LINE ส่งซ้ำ
  sh.appendRow([msgId, ts, fmtDate_(ts), CASE_DRAFT.UNIT, name].concat(CASE_KEYS.map(k => c[k]), [text, 'รอนำเข้า', '']));

  const vs = [['BP', c.bp], ['P', c.pr], ['R', c.rr], ['T', c.temp], ['SpO2', c.spo2 && c.spo2 + '%']].filter(x => x[1]).map(x => x.join(' '));
  const miss = [['patient', 'ชื่อผู้ป่วย'], ['hn', 'HN'], ['detail', 'เหตุการณ์']].filter(x => !c[x[0]]).map(x => x[1]);
  return '📝 รับร่างรายงานเคส ' + CASE_DRAFT.UNIT + ' แล้ว' +
    (c.hn ? '\nHN ' + c.hn : '') + '\nเวลา ' + c.time + (vs.length ? '\nV/S ' + vs.join(' · ') : '') +
    (miss.length ? '\nยังไม่พบ: ' + miss.join(', ') + ' (กรอกเพิ่มในระบบได้)' : '') +
    '\nเปิดระบบรายงาน > รายงานเคส > กด "ดึงเคสจาก LINE"';
}

function caseSheet_() {
  const ss = SpreadsheetApp.openById(prop_('REPORT_SHEET_ID'));
  let sh = ss.getSheetByName(CASE_DRAFT.SHEET);
  if (!sh) {
    sh = ss.insertSheet(CASE_DRAFT.SHEET);
    sh.appendRow(CASE_SHEET_HEADER);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, CASE_SHEET_HEADER.length).setFontWeight('bold');
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange('C:D').setNumberFormat('@');
    sh.getRange('F:Q').setNumberFormat('@');   // HN / เวลา / BP เก็บเป็นข้อความ ไม่ให้ Sheets แปลงเป็นตัวเลขหรือวันที่
  }
  return sh;
}

/** แยกข้อมูลเคสจากข้อความพิมพ์อิสระ เช่น "ชื่อ นายสมชาย ใจดี อายุ 67 HN 123456 / V/S T 38.5 P 120 R 28 BP 90/60 O2sat 89% cannula 3 LPM" */
function parseCaseReport_(text, ts) {
  const t = String(text).replace(/ /g, ' ');
  const c = {};
  CASE_KEYS.forEach(k => { c[k] = ''; });
  let m;

  // V/S — ตัวย่อต้องไม่ติดกับตัวอักษรอังกฤษด้านหน้า (P ใน BP, R ใน PR/HR, T ใน DTX ไม่นับ)
  const NB = '(?:^|[^A-Za-z])';
  if ((m = t.match(/B\s*\/?\s*P\s*[:=]?\s*(\d{2,3})\s*\/\s*(\d{2,3})/i))) c.bp = m[1] + '/' + m[2];
  if ((m = t.match(new RegExp(NB + '(?:PR|HR|P|ชีพจร)\\s*[:=]?\\s*(\\d{2,3})(?![\\d/.])', 'i')))) c.pr = m[1];
  if ((m = t.match(new RegExp(NB + '(?:RR|R|หายใจ)\\s*[:=]?\\s*(\\d{1,2})(?![\\d/.])', 'i')))) c.rr = m[1];
  if ((m = t.match(new RegExp(NB + '(?:BT|Temp|T|ไข้)\\s*[:=]?\\s*(\\d{2}(?:\\.\\d{1,2})?)(?![\\d/])', 'i'))) && m[1] >= 30 && m[1] <= 43) c.temp = m[1];
  if ((m = t.match(/(?:SpO2|SpO₂|O2\s*sat(?:uration)?|sat)\s*[:=]?\s*(\d{2,3})\s*%?/i)) && m[1] <= 100) c.spo2 = m[1];

  // O2: อุปกรณ์ + ปริมาณ (ค่าใน O2_MODES ของ daily-report)
  if (/HFNC|high\s*flow/i.test(t)) c.o2mode = 'HF';
  else if (/ET\s*tube|\bETT\b|on\s*tube/i.test(t)) c.o2mode = 'ET tube';
  else if (/mask|แมส/i.test(t)) c.o2mode = 'Mask';
  else if (/cannula|canula|\bNC\b|แคนนูล/i.test(t)) c.o2mode = 'Cannula';
  else if (/\bRA\b|room\s*air/i.test(t)) c.o2mode = 'Room air';
  if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:LPM|L\s*\/\s*min|lit(?:re|er)?s?|ลิตร)/i))) c.o2flow = m[1] + ' LPM';
  else if ((m = t.match(/FiO2\s*[:=]?\s*(\d{2,3})\s*%?/i))) c.o2flow = 'FiO2 ' + m[1] + '%';
  if (c.o2mode === 'Room air') c.o2flow = '';

  // ผู้ป่วย
  if ((m = t.match(/HN\s*[:.]?\s*(\d[\d\-\/]*)/i))) c.hn = m[1];
  if ((m = t.match(/อายุ\s*[:=]?\s*(\d{1,3})\s*(ปี|เดือน|วัน)?(?:\s*(\d{1,2})\s*(เดือน|วัน))?/)) || (m = t.match(/(\d{1,3})\s*(ปี|y\/o|yo|yrs?)(?![A-Za-z])/i))) {
    c.age = !m[2] || !/เดือน|วัน/.test(m[2]) ? (m[3] ? m[1] + ' ปี ' + m[3] + ' ' + m[4] : m[1]) : m[1] + ' ' + m[2];
  }
  const STOP = /^(อายุ|HN|เวลา|age|V\/S|เพศ)/i;
  if ((m = t.match(/(?:^|\s)(?:ชื่อ(?:\s*-?\s*สกุล)?(?:ผู้ป่วย)?|(?:ผู้ป่วย|pt\.?|patient)\s*[:：])\s*[:：]?\s*([^\n]+)/im))) {
    c.patient = m[1].split(/\s+/).filter((w, i, a) => !a.slice(0, i + 1).some(x => STOP.test(x) || /\d/.test(x))).slice(0, 4).join(' ');
  }
  if (!c.patient && (m = t.match(/(นางสาว|นาง|นาย|น\.ส\.|ด\.ช\.|ด\.ญ\.|เด็กชาย|เด็กหญิง)\s*([^\s\d]+)(?:\s+([^\s\d]+))?/))) {
    c.patient = m[1] + m[2] + (m[3] && !STOP.test(m[3]) ? ' ' + m[3] : '');
  }

  // เวลา: ที่พิมพ์ว่า "เวลา 14.30" ถ้าไม่มีใช้เวลาที่ส่งข้อความ
  if ((m = t.match(/เวลา\s*[:=]?\s*(\d{1,2})\s*[.:]\s*(\d{2})/))) {
    if (+m[1] < 24 && +m[2] < 60) c.time = ('0' + m[1]).slice(-2) + ':' + m[2];
  }
  if (!c.time) c.time = fmtTime_(ts);

  // แพทย์: บรรทัดที่ขึ้นต้นด้วย "แพทย์" หรือคำนำหน้า พญ./นพ./Dr.
  if ((m = t.match(/^\s*(?:แพทย์(?:เจ้าของไข้|ผู้ตรวจ)?|doctor)\s*[:：]?\s*(.+)$/im))) c.doctor = m[1].trim();
  else if ((m = t.match(/((?:พญ|นพ)\.\s*[^\s\d,]+(?:\s+[^\s\d,]+)?|Dr\.?\s*[A-Za-zก-๙]+)/))) c.doctor = m[1].trim();

  // เหตุการณ์ / การแก้ไข: บรรทัดที่มีหัวข้อ (บรรทัดถัดไปที่ไม่มีหัวข้อต่อท้ายหัวข้อนั้น)
  // ถ้าไม่มีหัวข้อเหตุการณ์ ใช้บรรทัดอื่นที่ไม่ใช่บรรทัดชื่อ/HN/V/S
  const sec = { detail: [], action: [], free: [] };
  let cur = null;
  t.split(/\r?\n/).forEach(raw => {
    const line = raw.replace(CASE_DRAFT.TAG, '').trim();
    if (!line) return;
    const lm = line.match(/^[-•*]?\s*([^:：]{1,25}?)\s*[:：]\s*(.*)$/);
    const key = lm && Object.keys(CASE_LABELS).find(k => CASE_LABELS[k].test(lm[1].trim()));
    if (key) { cur = key; if (lm[2]) sec[key].push(lm[2]); return; }
    const header = /^(?:ชื่อ|ผู้ป่วย\s*[:：]|pt\.?\s*[:：]|HN|อายุ|เวลา|แพทย์|V\s*\/\s*S|vital)/i.test(line) ||
      ['bp', 'pr', 'rr', 'temp', 'spo2'].filter(k => c[k] && line.indexOf(c[k]) >= 0).length >= 2;
    if (cur) sec[cur].push(line);
    else if (!header) {   // บรรทัดที่มีชื่อ/อายุ/HN ปนกับเหตุการณ์ → ตัดส่วนที่กรอกลงช่องอื่นแล้วออก
      const rest = line.split(c.patient || '\u0000').join(' ').replace(/HN\s*[:.]?\s*\d[\d\-\/]*/i, ' ')
        .replace(/(?:อายุ\s*[:=]?\s*)?\d{1,3}\s*(?:ปี|y\/o|yo)(?:\s*\d{1,2}\s*(?:เดือน|วัน))?/i, ' ').replace(/\s+/g, ' ').trim();
      if (rest) sec.free.push(rest);
    }
  });
  c.detail = (sec.detail.length ? sec.detail : sec.free).join('\n');
  c.action = sec.action.join('\n');
  if (c.o2flow && !c.o2mode) c.detail = (c.detail ? c.detail + '\n' : '') + 'O2 ' + c.o2flow + ' (ไม่ระบุอุปกรณ์)';
  return c;
}

/** ทดสอบตัวแยกข้อความ (รันเองจากหน้า Apps Script แล้วดู Log) */
function testCaseParse() {
  ['#รายงานเคส\nชื่อ นายสมชาย ใจดี อายุ 67 HN 123456\nเวลา 14.30\nV/S T 38.5 P 120 R 28 BP 90/60 O2sat 89% on cannula 3 LPM\nเหตุการณ์: ผู้ป่วยหอบเหนื่อย ซึมลง\nแก้ไข: รายงานแพทย์ ให้ O2 เจาะ DTX',
    'นางสาวมาลี ศรีสุข 45 ปี HN 2201-55 หน้ามืดหน้าห้องตรวจ 3\nBP 85/50 PR 110 RR 22 SpO2 97% RA\nให้นอนราบ ยกขาสูง รายงาน พญ.สุดา'
  ].forEach(s => Logger.log(JSON.stringify(parseCaseReport_(s, new Date()), null, 1)));
}

/******************** LINE API ********************/
function lineApi_(path, payload, method) {
  const res = UrlFetchApp.fetch('https://api.line.me' + path, {
    method: method || 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop_('LINE_TOKEN') },
    payload: payload ? JSON.stringify(payload) : undefined,
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) console.error(path, res.getResponseCode(), res.getContentText());
  return res;
}

function replyText_(replyToken, text) {
  lineApi_('/v2/bot/message/reply', { replyToken, messages: [{ type: 'text', text }] });
}

function replyMessages_(replyToken, messages) {
  // คืนค่า false ถ้าส่งไม่ผ่าน → ผู้เรียกจะส่งเป็นข้อความธรรมดาแทน (ใช้ push เพราะ replyToken ใช้ซ้ำไม่ได้)
  const res = lineApi_('/v2/bot/message/reply', { replyToken, messages: messages.slice(0, 5) });
  return res.getResponseCode() < 300;
}

function pushText_(to, text) {
  lineApi_('/v2/bot/message/push', { to, messages: [{ type: 'text', text }] });
}

function getName_(src) {
  if (!src.userId) return '(ไม่ทราบชื่อ)';
  const cache = CacheService.getScriptCache();
  const key = 'name_' + src.userId;
  const hit = cache.get(key);
  if (hit) return hit;
  const path = src.groupId ? '/v2/bot/group/' + src.groupId + '/member/' + src.userId
    : src.roomId ? '/v2/bot/room/' + src.roomId + '/member/' + src.userId
    : '/v2/bot/profile/' + src.userId;
  let name = src.userId.slice(-6);
  try {
    const res = lineApi_(path, null, 'get');
    if (res.getResponseCode() === 200) name = JSON.parse(res.getContentText()).displayName || name;
  } catch (err) { console.error(err); }
  cache.put(key, name, 21600);
  return name;
}

/******************** ตัวช่วย ********************/
function ss_() {
  const id = prop_('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }

function isAllowed_(chatId) {
  const list = (prop_('ALLOWED_CHATS') || '').split(',').map(s => s.trim()).filter(String);
  return !list.length || list.includes(chatId);
}

function append_(name, row) {
  if (BUFFER) { (BUFFER[name] = BUFFER[name] || []).push(row); return; }
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {                       // สร้างชีตให้อัตโนมัติถ้ายังไม่มี
    sh = ss.insertSheet(name);
    sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
    sh.getRange('B:C').setNumberFormat('@');
  }
  sh.appendRow(row);
}

function readRows_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
}

function fmtDate_(d) { return Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd'); }
function fmtTime_(d) { return d instanceof Date ? Utilities.formatDate(d, CONFIG.TZ, 'HH:mm') : ''; }
function dateStr_(v) { return v instanceof Date ? fmtDate_(v) : String(v); }
function shortDate_(v) { const p = dateStr_(v).split('-'); return p[2] + '/' + p[1]; }
function thaiDate_(s) { const p = s.split('-'); return p[2] + '/' + p[1] + '/' + (Number(p[0]) + 543); }
function clip_(s, n) { s = String(s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; }

/******************** ทดสอบโดยไม่ต้องใช้ LINE ********************/
function testLocal() {
  const now = new Date();
  const chat = 'TEST';
  recordMessage_(chat, 'u1', 'พยาบาล A', 'text',
    '#ยอดผู้ป่วย\nวอร์ด: อายุรกรรม 1\nรับใหม่: 5\nจำหน่าย: 3\nส่งต่อ: 1\nคงเหลือ: 28', now);
  recordMessage_(chat, 'u2', 'พยาบาล B', 'text',
    '#เคส\nเคส: HN1001\nสถานะ: ใหม่\nรายละเอียด: ไข้สูง เฝ้าระวัง sepsis\n\nเคส: HN0999\nสถานะ: ปิด\nรายละเอียด: D/C แล้ว', now);
  recordMessage_(chat, 'u3', 'พยาบาล C', 'text',
    '#ผิดปกติ\nระดับ: สูง\nเหตุการณ์: ผู้ป่วยเตียง 12 พลัดตกเตียง\nการจัดการ: ตรวจร่างกาย แจ้งแพทย์เวร', now);
  recordMessage_(chat, 'u1', 'พยาบาล A', 'text', 'เตียง 4 แพ้ยา มีผื่นขึ้น แจ้งแพทย์แล้ว', now);
  Logger.log(buildSummary_(chat, fmtDate_(now)));
}
