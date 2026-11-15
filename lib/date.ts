import type { Frequency, RoutinePlan } from "./types";

export const WEEKDAYS = [
  { short: "ش", name: "شنبه", js: 6 },
  { short: "ی", name: "یکشنبه", js: 0 },
  { short: "د", name: "دوشنبه", js: 1 },
  { short: "س", name: "سه‌شنبه", js: 2 },
  { short: "چ", name: "چهارشنبه", js: 3 },
  { short: "پ", name: "پنجشنبه", js: 4 },
  { short: "ج", name: "جمعه", js: 5 },
];

export function toISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseISODate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function formatPersianDate(value: string | Date, options?: Intl.DateTimeFormatOptions): string {
  const date = typeof value === "string" ? parseISODate(value) : value;
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    day: "numeric",
    month: "long",
    ...options,
  }).format(date);
}

export function formatPersianFullDate(date: Date): string {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function getPersianWeekday(date: Date): string {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { weekday: "long" }).format(date);
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours} ساعت و ${rest} دقیقه`;
  if (hours) return `${hours} ساعت`;
  return `${rest} دقیقه`;
}

export function getMonthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  // Week starts on Saturday in the Persian UI.
  const offset = (first.getDay() + 1) % 7;
  const gridStart = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

export function addMonths(date: Date, amount: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth() + amount, 1, 12);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(date.getDate(), lastDay));
  return next;
}

export function addPersianMonths(date: Date, amount: number): Date {
  if (!Number.isInteger(amount) || amount === 0) return new Date(date);
  const original = getPersianDateParts(date);
  let targetMonth = getPersianMonthStart(date);
  const direction = amount > 0 ? 1 : -1;

  for (let index = 0; index < Math.abs(amount); index += 1) {
    targetMonth = direction > 0
      ? getPersianMonthStart(addDays(targetMonth, 35))
      : getPersianMonthStart(addDays(targetMonth, -1));
  }

  const targetDay = Math.min(original.day, getPersianMonthDayCount(targetMonth));
  return addDays(targetMonth, targetDay - 1);
}

export function generateDates(plan: RoutinePlan, fromISO: string, toISO: string): string[] {
  if (!plan.active) return [];
  const start = parseISODate(plan.startDate);
  const from = parseISODate(fromISO);
  const to = parseISODate(toISO);
  const end = plan.endDate ? parseISODate(plan.endDate) : to;
  const lower = start > from ? start : from;
  const upper = end < to ? end : to;
  if (lower > upper) return [];

  const result: string[] = [];
  const base = startOfDay(start);
  for (let cursor = startOfDay(lower); cursor <= upper; cursor = addDays(cursor, 1)) {
    const diffDays = Math.round((startOfDay(cursor).getTime() - base.getTime()) / 86_400_000);
    let matches = false;

    if (plan.frequency === "once") {
      matches = toISODate(cursor) === plan.startDate;
    } else if (plan.frequency === "daily") {
      matches = diffDays >= 0 && diffDays % Math.max(1, plan.interval) === 0;
    } else if (plan.frequency === "weekly") {
      const selected = plan.weekdays.length ? plan.weekdays : [cursor.getDay()];
      const weekStart = (date: Date) => {
        const dayOffset = (date.getDay() + 1) % 7;
        return startOfDay(addDays(date, -dayOffset)).getTime();
      };
      const weekDiff = Math.round((weekStart(cursor) - weekStart(start)) / (7 * 86_400_000));
      matches = weekDiff >= 0 && weekDiff % Math.max(1, plan.interval) === 0 && selected.includes(cursor.getDay());
    } else if (plan.frequency === "monthly") {
      // Monthly schedules follow the Persian calendar shown to the user.
      const startParts = getPersianDateParts(start);
      const cursorParts = getPersianDateParts(cursor);
      const monthDiff = (cursorParts.year - startParts.year) * 12 + cursorParts.month - startParts.month;
      const targetDay = Math.min(Math.max(1, plan.monthDay || startParts.day), getPersianMonthDayCount(cursor));
      matches = monthDiff >= 0 && monthDiff % Math.max(1, plan.interval) === 0 && cursorParts.day === targetDay;
    } else if (plan.frequency === "yearly") {
      // Yearly schedules repeat on the same Persian month and day.
      const startParts = getPersianDateParts(start);
      const cursorParts = getPersianDateParts(cursor);
      const yearDiff = cursorParts.year - startParts.year;
      const monthStart = getPersianMonthStart(cursor);
      const targetDay = Math.min(startParts.day, getPersianMonthDayCount(monthStart));
      matches = yearDiff >= 0 && yearDiff % Math.max(1, plan.interval) === 0 && cursorParts.month === startParts.month && cursorParts.day === targetDay;
    }

    if (matches) result.push(toISODate(cursor));
  }
  return result;
}

export function frequencyLabel(frequency: Frequency): string {
  if (frequency === "once") return "فقط یک‌بار";
  if (frequency === "daily") return "روزانه";
  if (frequency === "weekly") return "هفتگی";
  if (frequency === "yearly") return "سالانه";
  return "ماهانه";
}

export function getWeekRange(date: Date): { start: Date; end: Date } {
  const offset = (date.getDay() + 1) % 7;
  const start = startOfDay(addDays(date, -offset));
  return { start, end: addDays(start, 6) };
}

function toAsciiDigits(value: string): string {
  return value.replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

export function getPersianDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(date);
  const read = (type: "year" | "month" | "day") => Number(toAsciiDigits(parts.find((part) => part.type === type)?.value ?? "0"));
  return { year: read("year"), month: read("month"), day: read("day") };
}

export function getPersianMonthStart(anchor: Date): Date {
  const target = getPersianDateParts(anchor);
  let cursor = startOfDay(anchor);
  for (let index = 0; index < 35; index += 1) {
    const previous = addDays(cursor, -1);
    const parts = getPersianDateParts(previous);
    if (parts.year !== target.year || parts.month !== target.month) break;
    cursor = previous;
  }
  return new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 12);
}


export function getPersianMonthDayCount(anchor: Date): number {
  const first = getPersianMonthStart(anchor);
  const next = getPersianMonthStart(addDays(first, 35));
  return Math.round((next.getTime() - first.getTime()) / 86_400_000);
}

export function getPersianMonthGrid(anchor: Date): Date[] {
  const first = getPersianMonthStart(anchor);
  const nextMonthStart = getPersianMonthStart(addDays(first, 35));
  const daysInMonth = Math.round((nextMonthStart.getTime() - first.getTime()) / 86_400_000);
  const offset = (first.getDay() + 1) % 7;
  const totalDays = Math.ceil((offset + daysInMonth) / 7) * 7;
  const gridStart = addDays(first, -offset);
  return Array.from({ length: totalDays }, (_, index) => addDays(gridStart, index));
}

export function isSamePersianMonth(date: Date, anchor: Date): boolean {
  const left = getPersianDateParts(date);
  const right = getPersianDateParts(anchor);
  return left.year === right.year && left.month === right.month;
}

export function shiftPersianMonth(anchor: Date, amount: -1 | 1): Date {
  const first = getPersianMonthStart(anchor);
  const probe = amount > 0 ? addDays(first, 35) : addDays(first, -1);
  return getPersianMonthStart(probe);
}

export function getPersianMonthLabel(anchor: Date): string {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { month: "long", year: "numeric" }).format(anchor);
}

export function getPersianDayNumber(date: Date): string {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { day: "numeric" }).format(date);
}
