"use client";

import {
  Activity, ArrowDownToLine, ArrowLeft, Bell, CalendarDays,
  Check, CheckCheck, ChevronLeft, ChevronRight, CircleHelp, Clock3,
  FolderHeart, Gauge, LayoutDashboard, ListChecks, Moon, Pause, Play, Plus,
  Repeat2, Search, Settings2, ShieldCheck, Sparkles, Sun, Target, Timer,
  Trash2, TrendingUp, Upload, X, Zap, ChartNoAxesCombined, RotateCcw,
} from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  addDays, addPersianMonths, formatDuration, formatPersianDate, formatPersianFullDate,
  frequencyLabel, generateDates, getPersianDateParts, getPersianDayNumber, getPersianMonthGrid,
  getPersianMonthLabel, getPersianMonthStart, getWeekRange, isSamePersianMonth, parseISODate,
  shiftPersianMonth, toISODate, todayISO, WEEKDAYS,
} from "@/lib/date";
import {
  getAll, getAllData, getSettings, put, remove, saveBackup, saveSettings,
} from "@/lib/db";
import type {
  AppSettings, BackupData, Category, Goal, Occurrence, RoutinePlan,
} from "@/lib/types";
import PwaInstallButton from "@/components/PwaInstallButton";
import JalaliDatePicker from "@/components/JalaliDatePicker";
import { cancelPushReminders, getOrCreatePushSubscription, readPushAccessKey, savePushAccessKey, schedulePushReminder, type PushSubscriptionPayload } from "@/lib/push-client";

const DEFAULT_SETTINGS: AppSettings = {
  darkMode: false,
  notificationsEnabled: false,
  quietStart: "23:00",
  quietEnd: "07:00",
  weekStartsOn: 6,
};

type View = "dashboard" | "today" | "plans" | "calendar" | "analytics" | "goals" | "categories" | "settings";

const NAV_ITEMS: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "نمای کلی", icon: LayoutDashboard },
  { id: "today", label: "برنامه امروز", icon: ListChecks },
  { id: "plans", label: "برنامه‌های تکرارشونده", icon: Repeat2 },
  { id: "calendar", label: "تقویم", icon: CalendarDays },
  { id: "analytics", label: "آمار و تحلیل", icon: ChartNoAxesCombined },
  { id: "goals", label: "هدف‌ها", icon: Target },
  { id: "categories", label: "دسته‌بندی‌ها", icon: FolderHeart },
  { id: "settings", label: "تنظیمات و پشتیبان‌گیری", icon: Settings2 },
];

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const formatNumber = (value: number) => new Intl.NumberFormat("fa-IR").format(value);
const formatClock = (value: string) => value;
const formatSeconds = (seconds: number) => {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

function createOccurrence(plan: RoutinePlan, date: string): Occurrence {
  return {
    id: `${plan.id}_${date}`,
    planId: plan.id,
    title: plan.title,
    categoryId: plan.categoryId,
    date,
    startTime: plan.startTime,
    durationMinutes: plan.durationMinutes,
    status: "pending",
    spentSeconds: 0,
    startedAt: null,
    completedAt: null,
    note: "",
    reminderSent: false,
  };
}

function getPlanOccurences(plans: RoutinePlan[], existing: Occurrence[], horizon = 400): Occurrence[] {
  const from = todayISO();
  const to = toISODate(addDays(new Date(), horizon));
  const known = new Set(existing.map((item) => item.id));
  const generated: Occurrence[] = [];
  for (const plan of plans) {
    if (!plan.active) continue;
    for (const date of generateDates(plan, from, to)) {
      const id = `${plan.id}_${date}`;
      if (!known.has(id)) generated.push(createOccurrence(plan, date));
    }
  }
  return generated;
}

function isSameDay(a: string, b: string) { return a === b; }

function normalizeDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

function numericDraft(value: string): string {
  return normalizeDigits(value).replace(/[^0-9]/g, "");
}

function parseIntegerDraft(value: string): number | null {
  const normalized = numericDraft(value);
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimeDraft(value: string): string {
  return normalizeDigits(value).replace(/[^0-9:]/g, "").slice(0, 5);
}

function parseTimeDraft(value: string): string | null {
  const draft = normalizeTimeDraft(value);
  let hoursText = "";
  let minutesText = "";

  if (/^\d{1,2}:\d{1,2}$/.test(draft)) {
    [hoursText, minutesText] = draft.split(":");
  } else if (/^\d{3,4}$/.test(draft)) {
    hoursText = draft.length === 3 ? draft.slice(0, 1) : draft.slice(0, 2);
    minutesText = draft.slice(-2);
  } else {
    return null;
  }

  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function withoutPushSchedule(item: Occurrence): Occurrence {
  const { reminderMessageId: _messageId, reminderScheduledAt: _scheduledAt, reminderSubscriptionEndpoint: _endpoint, ...rest } = item;
  return rest;
}

async function cancelRemoteReminders(items: Occurrence[], accessKey: string): Promise<void> {
  const messageIds = [...new Set(items.map((item) => item.reminderMessageId).filter((id): id is string => Boolean(id)))];
  if (!accessKey || !messageIds.length) return;
  for (let index = 0; index < messageIds.length; index += 100) {
    await cancelPushReminders(accessKey, messageIds.slice(index, index + 100));
  }
}

function StatCard({ label, value, note, icon: Icon, tone }: {
  label: string; value: string | number; note: string; icon: typeof Activity; tone: "violet" | "green" | "orange" | "blue";
}) {
  const tones = {
    violet: { bg: "var(--primary-soft)", color: "var(--primary)" },
    green: { bg: "rgba(32,167,121,.11)", color: "var(--green)" },
    orange: { bg: "rgba(233,154,62,.12)", color: "var(--orange)" },
    blue: { bg: "rgba(65,134,220,.12)", color: "#4186dc" },
  };
  return <div className="stat-card"><div className="stat-head"><span>{label}</span><span className="stat-icon" style={{ background: tones[tone].bg, color: tones[tone].color }}><Icon size={15} /></span></div><div className="stat-number">{value}</div><div className="stat-foot">{note}</div></div>;
}

function EmptyState({ title, copy, action }: { title: string; copy: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-illustration"><Sparkles size={22} /></div><div className="empty-title">{title}</div><div className="empty-copy">{copy}</div>{action && <div style={{ marginTop: 13 }}>{action}</div>}</div>;
}

function TaskRow({ item, category, onToggle, onStart, onDelete, elapsed }: {
  item: Occurrence; category?: Category; onToggle: () => void; onStart: () => void; onDelete?: () => void; elapsed: number;
}) {
  const done = item.status === "done";
  const running = Boolean(item.startedAt);
  return <div className={`task-row ${done ? "done" : ""}`}>
    <button className="task-check" aria-label={done ? "بازگرداندن فعالیت" : "تکمیل فعالیت"} onClick={onToggle}>{done && <Check size={13} />}</button>
    <div className="task-main">
      <div className="task-name">{item.title}</div>
      <div className="task-meta"><span><i className="task-category-dot" style={{ background: category?.color ?? "var(--primary)" }} /> {category?.name ?? "بدون دسته"}</span><span>{item.durationMinutes} دقیقه</span>{elapsed > 0 && <span>ثبت‌شده: {formatSeconds(elapsed)}</span>}</div>
    </div>
    <span className="task-time">{item.startTime}</span>
    {!done && <button className="task-more" onClick={onStart} title={running ? "توقف تایمر" : "شروع تایمر"}>{running ? <Pause size={15} color="var(--orange)" /> : <Play size={15} />}</button>}
    {onDelete && <button className="task-more" onClick={onDelete} title="حذف این جلسه"><X size={14} /></button>}
  </div>;
}

function ActivityModal({ open, onClose, categories, onSave, initialPlan }: {
  open: boolean; onClose: () => void; categories: Category[]; onSave: (plan: RoutinePlan) => void; initialPlan?: RoutinePlan | null;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [frequency, setFrequency] = useState<RoutinePlan["frequency"]>("weekly");
  // Keep numeric input drafts as strings so an empty field never collapses to 0.
  // Persian and Arabic digits are normalized before parsing/submission.
  const [interval, setInterval] = useState("1");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [monthDay, setMonthDay] = useState("1");
  const [startDate, setStartDate] = useState(todayISO());
  const [endMode, setEndMode] = useState("none");
  const [endDate, setEndDate] = useState(toISODate(addDays(new Date(), 30)));
  const [startTime, setStartTime] = useState("10:00");
  const [durationMinutes, setDurationMinutes] = useState("30");
  const [reminderMinutes, setReminderMinutes] = useState(10);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setCategoryId(initialPlan?.categoryId ?? categories[0]?.id ?? "");
    setTitle(initialPlan?.title ?? "");
    setDescription(initialPlan?.description ?? "");
    setFrequency(initialPlan?.frequency ?? "weekly");
    setInterval(String(initialPlan?.interval ?? 1));
    setWeekdays(initialPlan?.weekdays ?? []);
    setMonthDay(String(initialPlan?.monthDay ?? 1));
    setStartDate(initialPlan?.startDate ?? todayISO());
    setEndMode(initialPlan?.endDate ? "custom" : "none");
    setEndDate(initialPlan?.endDate ?? toISODate(addDays(new Date(), 30)));
    setStartTime(initialPlan?.startTime ?? "10:00");
    setDurationMinutes(String(initialPlan?.durationMinutes ?? 30));
    setReminderMinutes(initialPlan?.reminderMinutes ?? 10);
    setError("");
  }, [open, categories, initialPlan]);
  if (!open) return null;

  const toggleDay = (day: number) => setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) { setError("عنوان فعالیت را وارد کن."); return; }
    if (!categoryId) { setError("ابتدا یک دسته‌بندی بساز یا انتخاب کن."); return; }
    if (frequency === "weekly" && weekdays.length === 0) { setError("حداقل یک روز از هفته انتخاب کن."); return; }
    if (endMode === "custom" && endDate < startDate) { setError("تاریخ پایان نمی‌تواند قبل از تاریخ شروع باشد."); return; }

    const intervalValue = parseIntegerDraft(interval);
    const monthDayValue = parseIntegerDraft(monthDay);
    const durationValue = parseIntegerDraft(durationMinutes);
    const normalizedStartTime = parseTimeDraft(startTime);

    if (frequency !== "once" && (intervalValue === null || intervalValue < 1 || intervalValue > 999)) {
      setError("فاصله تکرار باید عددی بین ۱ تا ۹۹۹ باشد."); return;
    }
    if (frequency === "monthly" && (monthDayValue === null || monthDayValue < 1 || monthDayValue > 31)) {
      setError("روز ماه باید عددی بین ۱ تا ۳۱ باشد."); return;
    }
    if (durationValue === null || durationValue < 5 || durationValue > 1440) {
      setError("مدت فعالیت باید عددی بین ۵ تا ۱۴۴۰ دقیقه باشد."); return;
    }
    if (!normalizedStartTime) {
      setError("ساعت شروع معتبر نیست. ساعت را مانند ۰۹:۳۰ یا 0930 وارد کن."); return;
    }

    const resolvedEnd = frequency === "once" ? null : endMode === "none" ? null : endMode === "month" ? toISODate(addPersianMonths(parseISODate(startDate), 1)) : endMode === "quarter" ? toISODate(addPersianMonths(parseISODate(startDate), 3)) : endMode === "year" ? toISODate(addPersianMonths(parseISODate(startDate), 12)) : endDate;
    onSave({
      id: initialPlan?.id ?? uid(), title: title.trim(), description: description.trim(), categoryId, frequency, interval: frequency === "once" ? 1 : intervalValue!,
      weekdays: frequency === "weekly" ? weekdays : [], monthDay: frequency === "monthly" ? monthDayValue! : 1,
      startDate, endDate: resolvedEnd, startTime: normalizedStartTime, durationMinutes: durationValue, reminderMinutes,
      active: initialPlan?.active ?? true, createdAt: initialPlan?.createdAt ?? Date.now(),
    });
    setTitle(""); setDescription(""); setError(""); onClose();
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="activity-modal-title">
      <div className="modal-head"><div><div className="modal-title" id="activity-modal-title">{initialPlan ? "ویرایش برنامه" : "ساخت برنامه جدید"}</div><div className="modal-description">{initialPlan ? "تغییرات فقط روی جلسات آینده اعمال می‌شوند؛ سوابق گذشته حفظ خواهند شد." : "یک‌بار برنامه‌ات را تعریف کن؛ جلسات آینده به‌صورت خودکار ساخته می‌شوند."}</div></div><button className="icon-button" onClick={onClose}><X size={17} /></button></div>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="form-field full"><span className="form-label">عنوان فعالیت</span><input className="form-control" placeholder="مثلاً یادگیری مبانی شبکه" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
          <label className="form-field full"><span className="form-label">توضیحات (اختیاری)</span><input className="form-control" placeholder="هدف یا جزئیات این فعالیت..." value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          <label className="form-field"><span className="form-label">دسته‌بندی</span><select className="form-control" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!categories.length}><option value="">{categories.length ? "انتخاب دسته‌بندی" : "ابتدا دسته‌بندی بساز"}</option>{categories.map((cat) => <option key={cat.id} value={cat.id}>{cat.icon} {cat.name}</option>)}</select>{!categories.length && <span className="form-hint">برای ساخت برنامه، ابتدا از بخش «دسته‌بندی‌ها» یک دسته‌بندی دلخواه ایجاد کن.</span>}</label>
          <label className="form-field"><span className="form-label">الگوی تکرار</span><select className="form-control" value={frequency} onChange={(e) => setFrequency(e.target.value as RoutinePlan["frequency"])}><option value="once">فقط یک‌بار</option><option value="daily">روزانه</option><option value="weekly">هفتگی / روزهای انتخابی</option><option value="monthly">ماهانه</option><option value="yearly">سالانه</option></select></label>
          {frequency === "weekly" ? <div className="form-field full"><span className="form-label">روزهای انجام</span><div className="weekday-picker">{WEEKDAYS.map((day) => <button key={day.js} type="button" className={`weekday-option ${weekdays.includes(day.js) ? "selected" : ""}`} onClick={() => toggleDay(day.js)} title={day.name}>{day.short}</button>)}</div></div> : null}
          {frequency === "monthly" && <label className="form-field"><span className="form-label">روز ماه</span><input className="form-control numeric-input" type="text" inputMode="numeric" pattern="[0-9۰-۹٠-٩]*" dir="ltr" autoComplete="off" placeholder="۱ تا ۳۱" value={monthDay} onChange={(e) => setMonthDay(numericDraft(e.target.value))} /></label>}
          {frequency !== "once" && <label className="form-field"><span className="form-label">تکرار هر چند {frequency === "daily" ? "روز" : frequency === "weekly" ? "هفته" : frequency === "yearly" ? "سال" : "ماه"}؟</span><input className="form-control numeric-input" type="text" inputMode="numeric" pattern="[0-9۰-۹٠-٩]*" dir="ltr" autoComplete="off" placeholder="مثلاً ۱" value={interval} onChange={(e) => setInterval(numericDraft(e.target.value))} /></label>}
          <div className="form-field"><span className="form-label">تاریخ شروع (شمسی)</span><JalaliDatePicker value={startDate} onChange={setStartDate} ariaLabel="انتخاب تاریخ شروع شمسی" /></div>
          {frequency !== "once" && <label className="form-field"><span className="form-label">تاریخ پایان</span><select className="form-control" value={endMode} onChange={(e) => setEndMode(e.target.value)}><option value="none">بدون تاریخ پایان</option><option value="month">یک ماه بعد</option><option value="quarter">سه ماه بعد</option><option value="year">یک سال بعد</option><option value="custom">تاریخ دلخواه</option></select></label>}
          {frequency !== "once" && endMode === "custom" && <div className="form-field"><span className="form-label">پایان در تاریخ (شمسی)</span><JalaliDatePicker value={endDate} minDate={startDate} onChange={setEndDate} ariaLabel="انتخاب تاریخ پایان شمسی" /></div>}
          <label className="form-field"><span className="form-label">ساعت شروع</span><input className="form-control numeric-input" type="text" inputMode="numeric" dir="ltr" autoComplete="off" placeholder="۱۰:۰۰ یا 1000" value={startTime} onChange={(e) => setStartTime(normalizeTimeDraft(e.target.value))} onBlur={() => { const normalized = parseTimeDraft(startTime); if (normalized) setStartTime(normalized); }} /></label>
          <label className="form-field"><span className="form-label">مدت فعالیت (دقیقه)</span><input className="form-control numeric-input" type="text" inputMode="numeric" pattern="[0-9۰-۹٠-٩]*" dir="ltr" autoComplete="off" placeholder="مثلاً ۳۰" value={durationMinutes} onChange={(e) => setDurationMinutes(numericDraft(e.target.value))} /></label>
          <label className="form-field"><span className="form-label">یادآوری قبل از شروع</span><select className="form-control" value={reminderMinutes} onChange={(e) => setReminderMinutes(Number(e.target.value))}><option value={0}>بدون یادآوری</option><option value={5}>۵ دقیقه قبل</option><option value={10}>۱۰ دقیقه قبل</option><option value={15}>۱۵ دقیقه قبل</option><option value={30}>۳۰ دقیقه قبل</option><option value={60}>۱ ساعت قبل</option></select></label>
        </div>
        {error && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 12 }}>{error}</div>}
        <div className="form-actions"><button type="button" className="secondary-button" onClick={onClose}>انصراف</button><button type="submit" className="primary-button"><Plus size={14} /> {initialPlan ? "ذخیره تغییرات" : "ذخیره و ساخت جلسات"}</button></div>
      </form>
    </div>
  </div>;
}

export default function DashboardApp() {
  const [view, setView] = useState<View>("dashboard");
  const [categories, setCategories] = useState<Category[]>([]);
  const [plans, setPlans] = useState<RoutinePlan[]>([]);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [selectedDate, setSelectedDate] = useState(todayISO());
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [modalOpen, setModalOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<RoutinePlan | null>(null);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [planFilter, setPlanFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [analyticsPeriod, setAnalyticsPeriod] = useState<"week" | "month" | "year">("week");
  const [newGoalTitle, setNewGoalTitle] = useState("");
  const [newGoalHours, setNewGoalHours] = useState("");
  const [newGoalCategory, setNewGoalCategory] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryIcon, setNewCategoryIcon] = useState("✨");
  const [newCategoryColor, setNewCategoryColor] = useState("#6d5ce8");
  const backupInput = useRef<HTMLInputElement>(null);
  const pushSyncLock = useRef(false);
  const pushSyncPending = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pushAccessKey, setPushAccessKey] = useState("");
  const [pushAccessKeyDraft, setPushAccessKeyDraft] = useState("");
  const [pushSyncStatus, setPushSyncStatus] = useState("اعلان پس‌زمینه هنوز راه‌اندازی نشده است.");

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2800);
  }, []);

  useEffect(() => {
    const storedKey = readPushAccessKey();
    setPushAccessKey(storedKey);
    setPushAccessKeyDraft(storedKey);
  }, []);

  const persistPushAccessKey = () => {
    const value = pushAccessKeyDraft.trim();
    savePushAccessKey(value);
    setPushAccessKey(value);
    setPushSyncStatus(value ? "کد اتصال روی همین دستگاه ذخیره شد." : "کد اتصال پاک شد.");
    notify(value ? "کد اتصال اعلان ذخیره شد." : "کد اتصال اعلان حذف شد.");
  };

  const refreshStorage = useCallback(async () => {
    const [allCategories, allPlans, allOccurrences, allGoals] = await Promise.all([
      getAll<Category>("categories"), getAll<RoutinePlan>("plans"), getAll<Occurrence>("occurrences"), getAll<Goal>("goals"),
    ]);
    setCategories(allCategories);
    setPlans(allPlans);
    setOccurrences(allOccurrences);
    setGoals(allGoals);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        let localCategories = await getAll<Category>("categories");
        let localPlans = await getAll<RoutinePlan>("plans");
        let localOccurrences = await getAll<Occurrence>("occurrences");
        let localGoals = await getAll<Goal>("goals");

        // Clean up sample data created by older Routine OS builds, without touching custom data.
        const legacyCategoryIds = new Set([
          "cat-learning", "cat-sport", "cat-tech", "cat-work", "cat-reading", "cat-personal", "cat-leisure",
        ]);
        const legacyDemoPlans = localPlans.filter((plan) => plan.demo || plan.id.startsWith("demo-"));
        const legacyDemoPlanIds = new Set(legacyDemoPlans.map((plan) => plan.id));
        for (const plan of legacyDemoPlans) await remove("plans", plan.id);
        localPlans = localPlans.filter((plan) => !legacyDemoPlanIds.has(plan.id));

        const staleOccurrences = localOccurrences.filter((item) =>
          legacyDemoPlanIds.has(item.planId) || item.planId.startsWith("demo-")
        );
        for (const item of staleOccurrences) await remove("occurrences", item.id);
        localOccurrences = localOccurrences.filter((item) => !staleOccurrences.some((stale) => stale.id === item.id));

        const stillUsedLegacyCategories = new Set([
          ...localPlans.map((plan) => plan.categoryId),
          ...localGoals.map((goal) => goal.categoryId),
          ...localOccurrences.map((item) => item.categoryId),
        ]);
        const unusedLegacyCategories = localCategories.filter((category) =>
          legacyCategoryIds.has(category.id) && !stillUsedLegacyCategories.has(category.id)
        );
        for (const category of unusedLegacyCategories) await remove("categories", category.id);
        localCategories = localCategories.filter((category) => !unusedLegacyCategories.some((item) => item.id === category.id));

        const staleGoals = localGoals.filter((goal) => legacyCategoryIds.has(goal.categoryId) && !localCategories.some((category) => category.id === goal.categoryId));
        for (const goal of staleGoals) await remove("goals", goal.id);
        localGoals = localGoals.filter((goal) => !staleGoals.some((item) => item.id === goal.id));

        // Rebuild only future pending monthly/yearly occurrences after switching
        // recurrence semantics to the Persian calendar. Completed history and
        // currently running sessions are intentionally preserved.
        const recurrenceToday = todayISO();
        const recurrenceHorizon = toISODate(addDays(new Date(), 400));
        for (const plan of localPlans.filter((item) => item.active && (item.frequency === "monthly" || item.frequency === "yearly"))) {
          const expectedDates = new Set(generateDates(plan, recurrenceToday, recurrenceHorizon));
          const obsolete = localOccurrences.filter((item) =>
            item.planId === plan.id && item.date >= recurrenceToday && item.status === "pending" &&
            !item.startedAt && !expectedDates.has(item.date)
          );
          for (const item of obsolete) await remove("occurrences", item.id);
          if (obsolete.length) {
            const obsoleteIds = new Set(obsolete.map((item) => item.id));
            localOccurrences = localOccurrences.filter((item) => !obsoleteIds.has(item.id));
          }
        }

        const generated = getPlanOccurences(localPlans, localOccurrences, 400);
        if (generated.length) {
          for (const occurrence of generated) await put("occurrences", occurrence);
          localOccurrences = [...localOccurrences, ...generated];
        }
        let localSettings = (await getSettings()) ?? DEFAULT_SETTINGS;
        // Migrate the old foreground-only notification toggle. If no real Push
        // subscription exists yet, require the user to activate background Push.
        if (localSettings.notificationsEnabled) {
          let existingPushSubscription: PushSubscription | null = null;
          if ("serviceWorker" in navigator) {
            const registration = await navigator.serviceWorker.getRegistration("/");
            existingPushSubscription = registration ? await registration.pushManager.getSubscription() : null;
          }
          if (!existingPushSubscription) {
            localSettings = { ...localSettings, notificationsEnabled: false };
            await saveSettings(localSettings);
          }
        }
        if (!(await getSettings())) await saveSettings(localSettings);
        if (!active) return;
        setCategories(localCategories); setPlans(localPlans); setOccurrences(localOccurrences); setGoals(localGoals); setSettings(localSettings);
        document.documentElement.dataset.theme = localSettings.darkMode ? "dark" : "light";
        setReady(true);
        // Ask Chrome to keep this origin's IndexedDB storage persistently when possible.
        if (navigator.storage?.persist) void navigator.storage.persist().catch(() => false);
      } catch (error) {
        console.error(error);
        if (active) { notify("دسترسی به حافظه مرورگر ممکن نشد. تنظیمات سایت در Chrome را بررسی کن."); setReady(true); }
      }
    })();
    return () => { active = false; };
  }, [notify]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const today = todayISO();
  const todayItems = useMemo(() => occurrences.filter((item) => isSameDay(item.date, today)).sort((a, b) => a.startTime.localeCompare(b.startTime)), [occurrences, today]);
  const selectedItems = useMemo(() => occurrences.filter((item) => item.date === selectedDate).sort((a, b) => a.startTime.localeCompare(b.startTime)), [occurrences, selectedDate]);
  const todayDone = todayItems.filter((item) => item.status === "done").length;
  const todayPending = todayItems.filter((item) => item.status === "pending").length;
  const todayPlannedMinutes = todayItems.reduce((sum, item) => sum + item.durationMinutes, 0);
  const todaySpentMinutes = todayItems.reduce((sum, item) => sum + (item.spentSeconds + (item.startedAt ? Math.max(0, Math.floor((clock - item.startedAt) / 1000)) : 0)) / 60, 0);
  const progress = todayItems.length ? Math.round((todayDone / todayItems.length) * 100) : 0;
  const activePlans = plans.filter((plan) => plan.active);

  useEffect(() => {
    if (!ready) return;
    const generated = getPlanOccurences(plans, occurrences, 400);
    if (!generated.length) return;
    void Promise.all(generated.map((item) => put("occurrences", item))).then(() => {
      setOccurrences((current) => [...current, ...generated]);
    }).catch((error) => console.error("Could not extend routine schedule", error));
  // The date changes at local midnight. This extends the rolling schedule while the app stays open.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today, ready]);

  const nextTask = todayItems.find((item) => item.status === "pending" && item.startTime >= new Date().toTimeString().slice(0, 5));

  const categoryFor = useCallback((id: string) => categories.find((category) => category.id === id), [categories]);

  const persistOccurrence = useCallback(async (updated: Occurrence) => {
    await put("occurrences", updated);
    setOccurrences((current) => current.map((item) => item.id === updated.id ? updated : item));
  }, []);

  const toggleOccurrence = useCallback(async (item: Occurrence) => {
    if (item.status === "done") {
      await persistOccurrence({ ...withoutPushSchedule(item), status: "pending", completedAt: null });
      notify("فعالیت به فهرست انجام‌نشده برگشت.");
    } else {
      await cancelRemoteReminders([item], pushAccessKey);
      const elapsed = item.startedAt ? Math.max(0, Math.floor((Date.now() - item.startedAt) / 1000)) : 0;
      await persistOccurrence({ ...withoutPushSchedule(item), status: "done", completedAt: Date.now(), spentSeconds: item.spentSeconds + elapsed, startedAt: null });
      notify("آفرین! فعالیت تکمیل شد.");
    }
  }, [notify, persistOccurrence, pushAccessKey]);

  const toggleTimer = useCallback(async (item: Occurrence) => {
    if (item.status === "done") return;
    if (item.startedAt) {
      const elapsed = Math.max(0, Math.floor((Date.now() - item.startedAt) / 1000));
      await persistOccurrence({ ...item, startedAt: null, spentSeconds: item.spentSeconds + elapsed });
      notify(`تایمر متوقف شد؛ ${formatSeconds(elapsed)} به زمان فعالیت اضافه شد.`);
      return;
    }
    const otherRunning = occurrences.find((other) => other.startedAt && other.id !== item.id);
    if (otherRunning) {
      const elapsed = Math.max(0, Math.floor((Date.now() - (otherRunning.startedAt ?? Date.now())) / 1000));
      await persistOccurrence({ ...otherRunning, startedAt: null, spentSeconds: otherRunning.spentSeconds + elapsed });
    }
    await cancelRemoteReminders([item], pushAccessKey);
    await persistOccurrence({ ...withoutPushSchedule(item), startedAt: Date.now() });
    notify("تایمر فعالیت شروع شد.");
  }, [notify, occurrences, persistOccurrence, pushAccessKey]);

  const deleteOccurrence = useCallback(async (item: Occurrence) => {
    if (!window.confirm(`جلسه «${item.title}» در ${formatPersianDate(item.date)} حذف شود؟`)) return;
    await cancelRemoteReminders([item], pushAccessKey);
    await remove("occurrences", item.id);
    setOccurrences((current) => current.filter((value) => value.id !== item.id));
    notify("جلسه حذف شد.");
  }, [notify, pushAccessKey]);

  const savePlan = useCallback(async (plan: RoutinePlan) => {
    const isEditing = plans.some((item) => item.id === plan.id);
    if (isEditing) {
      const preserved = occurrences.filter((item) => !(item.planId === plan.id && item.date >= todayISO() && item.status === "pending" && !item.startedAt));
      const removed = occurrences.filter((item) => item.planId === plan.id && item.date >= todayISO() && item.status === "pending" && !item.startedAt);
      await cancelRemoteReminders(removed, pushAccessKey);
      for (const item of removed) await remove("occurrences", item.id);
      await put("plans", plan);
      const generated = getPlanOccurences([plan], preserved, 400);
      for (const occurrence of generated) await put("occurrences", occurrence);
      setPlans((current) => current.map((item) => item.id === plan.id ? plan : item));
      setOccurrences([...preserved, ...generated]);
      notify(`تغییرات ذخیره شد؛ ${formatNumber(generated.length)} جلسه آینده به‌روزرسانی شد.`);
    } else {
      await put("plans", plan);
      const generated = getPlanOccurences([plan], occurrences, 400);
      for (const occurrence of generated) await put("occurrences", occurrence);
      setPlans((current) => [plan, ...current]);
      setOccurrences((current) => [...current, ...generated]);
      notify(`برنامه ساخته شد؛ ${formatNumber(generated.length)} جلسه در تقویم ثبت شد.`);
    }
    setEditingPlan(null);
    setView("plans");
  }, [notify, occurrences, plans, pushAccessKey]);

  const openNewPlan = () => { setEditingPlan(null); setModalOpen(true); };
  const openEditPlan = (plan: RoutinePlan) => { setEditingPlan(plan); setModalOpen(true); };

  const togglePlan = useCallback(async (plan: RoutinePlan) => {
    const updated = { ...plan, active: !plan.active };
    await put("plans", updated);
    setPlans((current) => current.map((item) => item.id === plan.id ? updated : item));
    if (updated.active) {
      const generated = getPlanOccurences([updated], occurrences, 400);
      for (const occurrence of generated) await put("occurrences", occurrence);
      setOccurrences((current) => [...current, ...generated]);
    } else {
      const removed = occurrences.filter((item) => item.planId === plan.id && item.date >= todayISO() && item.status === "pending" && !item.startedAt);
      await cancelRemoteReminders(removed, pushAccessKey);
      for (const item of removed) await remove("occurrences", item.id);
      setOccurrences((current) => current.filter((item) => !removed.some((gone) => gone.id === item.id)));
    }
    notify(updated.active ? "برنامه دوباره فعال شد." : "برنامه متوقف شد؛ جلسات آینده لغو و سوابق قبلی حفظ شدند.");
  }, [notify, occurrences, pushAccessKey]);

  const deletePlan = useCallback(async (plan: RoutinePlan) => {
    const answer = window.confirm(`برنامه «${plan.title}» حذف شود؟\nسوابق قبلی جلسات باقی می‌مانند.`);
    if (!answer) return;
    await remove("plans", plan.id);
    const removed = occurrences.filter((item) => item.planId === plan.id && item.date >= todayISO() && item.status === "pending" && !item.startedAt);
    await cancelRemoteReminders(removed, pushAccessKey);
    for (const item of removed) await remove("occurrences", item.id);
    setOccurrences((current) => current.filter((item) => !removed.some((gone) => gone.id === item.id)));
    setPlans((current) => current.filter((item) => item.id !== plan.id));
    notify("تعریف برنامه حذف شد. سوابق جلسات قبلی حفظ شدند.");
  }, [notify, pushAccessKey]);

  const updateAppSettings = async (next: AppSettings) => {
    setSettings(next);
    await saveSettings(next);
    document.documentElement.dataset.theme = next.darkMode ? "dark" : "light";
  };

  const enableNotifications = async () => {
    if (!pushAccessKey) {
      setView("settings");
      notify("ابتدا کد اتصال اعلان را در تنظیمات ذخیره کن.");
      return;
    }
    if (!("Notification" in window)) { notify("این مرورگر از اعلان پشتیبانی نمی‌کند."); return; }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      notify("این مرورگر از اعلان پس‌زمینه پشتیبانی نمی‌کند."); return;
    }

    try {
      const permission = Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
      if (permission !== "granted") {
        notify("اجازه اعلان صادر نشد. مجوز سایت را در تنظیمات مرورگر فعال کن.");
        return;
      }
      await getOrCreatePushSubscription();
      await updateAppSettings({ ...settings, notificationsEnabled: true });
      setPushSyncStatus("اشتراک دستگاه فعال شد؛ در حال ثبت یادآوری‌های نزدیک...");
      notify("اعلان پس‌زمینه فعال شد.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "راه‌اندازی اعلان ناموفق بود.";
      setPushSyncStatus(message);
      notify(message);
    }
  };

  const disableNotifications = async () => {
    try {
      await cancelRemoteReminders(occurrences, pushAccessKey);
      const cleared = occurrences.filter((item) => item.reminderMessageId).map(withoutPushSchedule);
      for (const item of cleared) await put("occurrences", item);
      if (cleared.length) {
        const clearedById = new Map(cleared.map((item) => [item.id, item]));
        setOccurrences((current) => current.map((item) => clearedById.get(item.id) ?? item));
      }
      await updateAppSettings({ ...settings, notificationsEnabled: false });
      setPushSyncStatus("اعلان‌ها خاموش شدند و یادآوری‌های در صف لغو شدند.");
      notify("اعلان‌ها غیرفعال شدند.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "لغو اعلان‌ها ناموفق بود.");
    }
  };

  const sendTestNotification = async () => {
    if (!pushAccessKey) { notify("ابتدا کد اتصال اعلان را ذخیره کن."); return; }
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) throw new Error("اشتراک Push پیدا نشد؛ ابتدا اعلان‌ها را فعال کن.");
      await schedulePushReminder(pushAccessKey, {
        subscription: subscription.toJSON() as unknown as PushSubscriptionPayload,
        occurrenceId: `test-${uid()}`,
        scheduledAt: Date.now() + 20_000,
        title: "اعلان آزمایشی روزبان",
        body: "عالی! اعلان پس‌زمینه دستگاهت به‌درستی کار می‌کند.",
        url: "/",
      });
      notify("اعلان آزمایشی ثبت شد؛ حدود ۲۰ ثانیه دیگر باید برسد.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "ارسال اعلان آزمایشی ناموفق بود.";
      setPushSyncStatus(message);
      notify(message);
    }
  };

  useEffect(() => {
    if (!ready || !settings.notificationsEnabled || !pushAccessKey) return;
    let mounted = true;

    const synchronizeReminders = async () => {
      if (pushSyncLock.current) {
        pushSyncPending.current = true;
        return;
      }
      pushSyncLock.current = true;
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          if (mounted) setPushSyncStatus("اشتراک دستگاه وجود ندارد؛ اعلان‌ها را دوباره فعال کن.");
          return;
        }

        const subscriptionPayload = subscription.toJSON() as unknown as PushSubscriptionPayload;
        const endpoint = subscription.endpoint;
        const planById = new Map(plans.map((plan) => [plan.id, plan]));
        const now = Date.now();
        const maxScheduledAt = now + 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000;
        const nextOccurrences = [...occurrences];
        let scheduledCount = 0;
        let cancelledCount = 0;

        for (let index = 0; index < nextOccurrences.length; index += 1) {
          if (!mounted) break;
          const item = nextOccurrences[index];
          const plan = planById.get(item.planId);
          const hasReminder = Boolean(plan?.active && plan.reminderMinutes > 0 && item.status === "pending" && !item.startedAt && !item.reminderSent);
          const [hours, minutes] = item.startTime.split(":").map(Number);
          const sessionAt = new Date(`${item.date}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`).getTime();
          const scheduledAt = sessionAt - (plan?.reminderMinutes ?? 0) * 60_000;
          const inSchedulingWindow = Number.isFinite(scheduledAt) && scheduledAt > now + 15_000 && scheduledAt <= maxScheduledAt;
          const matchesCurrent = Boolean(
            item.reminderMessageId
            && item.reminderScheduledAt === scheduledAt
            && item.reminderSubscriptionEndpoint === endpoint
          );

          if ((!hasReminder || !inSchedulingWindow || !matchesCurrent) && item.reminderMessageId) {
            await cancelRemoteReminders([item], pushAccessKey);
            const cleared = withoutPushSchedule(item);
            nextOccurrences[index] = cleared;
            await put("occurrences", cleared);
            cancelledCount += 1;
          }

          if (!hasReminder || !inSchedulingWindow || matchesCurrent) continue;
          const result = await schedulePushReminder(pushAccessKey, {
            subscription: subscriptionPayload,
            occurrenceId: item.id,
            scheduledAt,
            title: "یادآوری فعالیت",
            body: `${item.title} تا ${plan!.reminderMinutes} دقیقه دیگر شروع می‌شود.`,
            url: "/",
          });
          if (!mounted) {
            await cancelRemoteReminders([{ ...item, reminderMessageId: result.messageId }], pushAccessKey);
            break;
          }
          const updated: Occurrence = {
            ...nextOccurrences[index],
            reminderMessageId: result.messageId,
            reminderScheduledAt: scheduledAt,
            reminderSubscriptionEndpoint: endpoint,
          };
          nextOccurrences[index] = updated;
          await put("occurrences", updated);
          scheduledCount += 1;
        }

        if (mounted && (scheduledCount > 0 || cancelledCount > 0)) {
          const updatedById = new Map(nextOccurrences.map((item) => [item.id, item]));
          setOccurrences((current) => current.map((item) => updatedById.get(item.id) ?? item));
        }
        if (mounted) {
          setPushSyncStatus(`${scheduledCount} یادآوری جدید ثبت شد؛ ${cancelledCount} یادآوری قبلی لغو شد.`);
        }
      } catch (error) {
        console.error("Push reminder synchronization failed:", error);
        if (mounted) {
          try {
            setOccurrences(await getAll<Occurrence>("occurrences"));
          } catch (refreshError) {
            console.error("Could not refresh reminder metadata:", refreshError);
          }
          setPushSyncStatus(error instanceof Error ? error.message : "همگام‌سازی اعلان‌ها ناموفق بود.");
        }
      } finally {
        pushSyncLock.current = false;
        if (pushSyncPending.current) {
          pushSyncPending.current = false;
          window.setTimeout(() => {
            if (document.visibilityState === "visible") window.dispatchEvent(new Event("focus"));
          }, 250);
        }
      }
    };

    void synchronizeReminders();
    const interval = window.setInterval(() => void synchronizeReminders(), 6 * 60 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void synchronizeReminders();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      mounted = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [ready, settings.notificationsEnabled, pushAccessKey, plans, occurrences]);

  const exportBackup = async () => {
    try {
      const data = await getAllData(settings);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `routine-os-backup-${today}.json`; anchor.click(); URL.revokeObjectURL(url);
      notify("فایل پشتیبان دانلود شد.");
    } catch { notify("ساخت نسخه پشتیبان با خطا روبه‌رو شد."); }
  };

  const importBackup = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as BackupData;
      if (parsed.version !== 1 || !Array.isArray(parsed.categories) || !Array.isArray(parsed.plans) || !Array.isArray(parsed.occurrences) || !Array.isArray(parsed.goals) || !parsed.settings) throw new Error("Invalid backup");
      if (!window.confirm("بازیابی نسخه پشتیبان، اطلاعات فعلی این مرورگر را جایگزین می‌کند. ادامه می‌دهی؟")) return;
      const portableBackup: BackupData = {
        ...parsed,
        settings: { ...parsed.settings, notificationsEnabled: false },
        occurrences: parsed.occurrences.map(withoutPushSchedule),
      };
      await saveBackup(portableBackup);
      await refreshStorage();
      setSettings(portableBackup.settings);
      document.documentElement.dataset.theme = portableBackup.settings.darkMode ? "dark" : "light";
      notify("اطلاعات با موفقیت بازیابی شدند.");
    } catch { notify("فایل انتخاب‌شده معتبر نیست یا قابل بازیابی نیست."); }
    finally { if (backupInput.current) backupInput.current.value = ""; }
  };

  const addGoal = async (event: FormEvent) => {
    event.preventDefault();
    const goalHours = parseIntegerDraft(newGoalHours);
    if (!newGoalTitle.trim() || !newGoalCategory || goalHours === null || goalHours < 1 || goalHours > 500) {
      notify("عنوان، دسته‌بندی و مقدار ساعت معتبر (۱ تا ۵۰۰) را وارد کن.");
      return;
    }
    const goal: Goal = { id: uid(), title: newGoalTitle.trim(), categoryId: newGoalCategory, targetMinutes: goalHours * 60, period: "month", createdAt: Date.now() };
    await put("goals", goal); setGoals((current) => [goal, ...current]); setNewGoalTitle(""); setNewGoalHours(""); notify("هدف جدید اضافه شد.");
  };

  const deleteGoal = async (goal: Goal) => {
    if (!window.confirm(`هدف «${goal.title}» حذف شود؟`)) return;
    await remove("goals", goal.id); setGoals((current) => current.filter((item) => item.id !== goal.id)); notify("هدف حذف شد.");
  };

  const addCategory = async (event: FormEvent) => {
    event.preventDefault();
    if (!newCategoryName.trim()) return;
    const category: Category = { id: uid(), name: newCategoryName.trim(), icon: newCategoryIcon || "✨", color: newCategoryColor, tint: `${newCategoryColor}18`, createdAt: Date.now() };
    await put("categories", category); setCategories((current) => [...current, category]); setNewCategoryName(""); notify("دسته‌بندی اضافه شد.");
  };

  const deleteCategory = async (category: Category) => {
    if (plans.some((plan) => plan.categoryId === category.id) || occurrences.some((item) => item.categoryId === category.id) || goals.some((goal) => goal.categoryId === category.id)) {
      notify("این دسته‌بندی به برنامه یا سابقه‌ای متصل است و فعلاً قابل حذف نیست."); return;
    }
    if (!window.confirm(`دسته‌بندی «${category.name}» حذف شود؟`)) return;
    await remove("categories", category.id); setCategories((current) => current.filter((item) => item.id !== category.id)); notify("دسته‌بندی حذف شد.");
  };

  const weeklyChart = useMemo(() => {
    const { start } = getWeekRange(new Date());
    return Array.from({ length: 7 }, (_, index) => {
      const date = toISODate(addDays(start, index));
      const items = occurrences.filter((item) => item.date === date);
      return {
        day: new Intl.DateTimeFormat("fa-IR-u-ca-persian", { weekday: "short" }).format(parseISODate(date)),
        planned: items.length,
        done: items.filter((item) => item.status === "done").length,
        minutes: items.filter((item) => item.status === "done").reduce((sum, item) => sum + (item.spentSeconds / 60), 0),
      };
    });
  }, [occurrences]);

  const analyticsChart = useMemo(() => {
    const now = new Date();
    const buildPoint = (label: string, items: Occurrence[]) => ({
      day: label,
      planned: items.length,
      done: items.filter((item) => item.status === "done").length,
      minutes: items.filter((item) => item.status === "done").reduce((sum, item) => sum + (item.spentSeconds / 60), 0),
    });
    if (analyticsPeriod === "week") {
      const { start } = getWeekRange(now);
      return Array.from({ length: 7 }, (_, index) => {
        const date = toISODate(addDays(start, index));
        const items = occurrences.filter((item) => item.date === date);
        return buildPoint(new Intl.DateTimeFormat("fa-IR-u-ca-persian", { weekday: "short" }).format(parseISODate(date)), items);
      });
    }
    if (analyticsPeriod === "month") {
      const days = getPersianMonthGrid(now).filter((date) => isSamePersianMonth(date, now));
      return days.map((day) => {
        const date = toISODate(day);
        const items = occurrences.filter((item) => item.date === date);
        return buildPoint(getPersianDayNumber(day), items);
      });
    }
    let yearStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    for (let offset = 0; offset < 370; offset += 1) {
      const parts = getPersianDateParts(yearStart);
      if (parts.month === 1 && parts.day === 1) break;
      yearStart = addDays(yearStart, -1);
    }
    const yearPoints: Array<{ day: string; planned: number; done: number; minutes: number }> = [];
    let monthAnchor = yearStart;
    for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
      const monthStart = getPersianMonthStart(monthAnchor);
      const nextMonthStart = getPersianMonthStart(addDays(monthStart, 35));
      const startKey = toISODate(monthStart);
      const endKey = toISODate(nextMonthStart);
      const items = occurrences.filter((item) => item.date >= startKey && item.date < endKey);
      yearPoints.push(buildPoint(new Intl.DateTimeFormat("fa-IR-u-ca-persian", { month: "short" }).format(monthStart), items));
      monthAnchor = nextMonthStart;
    }
    return yearPoints;
  }, [analyticsPeriod, occurrences]);

  const categoryChart = useMemo(() => categories.map((category) => {
    const items = occurrences.filter((item) => item.categoryId === category.id && item.status === "done");
    const value = items.reduce((sum, item) => sum + (item.spentSeconds / 60), 0);
    return { name: category.name, value: Math.round(value), color: category.color, icon: category.icon };
  }).filter((item) => item.value > 0), [categories, occurrences]);

  const calendarDays = useMemo(() => getPersianMonthGrid(calendarMonth), [calendarMonth]);
  const calendarMonthName = getPersianMonthLabel(calendarMonth);

  const currentViewTitle = NAV_ITEMS.find((item) => item.id === view)?.label ?? "نمای کلی";
  const viewEyebrow = view === "dashboard" ? "نمای امروزت در یک نگاه" : "فضای شخصی تو";

  const renderTask = (item: Occurrence, withDelete = false) => {
    const elapsed = item.spentSeconds + (item.startedAt ? Math.max(0, Math.floor((clock - item.startedAt) / 1000)) : 0);
    return <TaskRow key={item.id} item={item} category={categoryFor(item.categoryId)} elapsed={elapsed} onToggle={() => void toggleOccurrence(item)} onStart={() => void toggleTimer(item)} onDelete={withDelete ? () => void deleteOccurrence(item) : undefined} />;
  };

  const renderDashboard = () => <div className="content-stack">
    <div className="welcome-banner">
      <div className="welcome-copy"><div className="welcome-date">{formatPersianFullDate(new Date())}</div><div className="welcome-title">امروز، یک فرصت تازه برای<br />ساختن نسخه بهتر خودته.</div><div className="welcome-description">قدم‌های کوچک و پیوسته، نتیجه‌های بزرگ می‌سازند. با برنامه خودت پیش برو.</div></div>
      <div className="banner-progress"><div className="banner-progress-inner"><div className="banner-progress-number">{formatNumber(progress)}٪</div><div className="banner-progress-label">پیشرفت امروز</div></div></div>
    </div>
    <div className="stats-grid">
      <StatCard label="فعالیت‌های امروز" value={formatNumber(todayItems.length)} note="جلسه برنامه‌ریزی‌شده" icon={CalendarDays} tone="violet" />
      <StatCard label="تکمیل‌شده" value={formatNumber(todayDone)} note={`${formatNumber(progress)}٪ از برنامه امروز`} icon={CheckCheck} tone="green" />
      <StatCard label="باقی‌مانده" value={formatNumber(todayPending)} note="فعالیت در انتظار انجام" icon={Clock3} tone="orange" />
      <StatCard label="زمان برنامه‌ریزی‌شده" value={`${formatNumber(Math.round(todayPlannedMinutes / 60 * 10) / 10)} ساعت`} note={`زمان ثبت‌شده: ${formatNumber(Math.round(todaySpentMinutes))} دقیقه`} icon={Timer} tone="blue" />
    </div>
    <div className="grid-two">
      <section className="panel">
        <div className="panel-header"><div><div className="panel-title">برنامه امروز</div><div className="panel-subtitle">{formatPersianDate(today, { weekday: "long", year: "numeric" })} · {formatNumber(todayItems.length)} فعالیت</div></div><button className="text-link" onClick={() => setView("today")}>مشاهده همه <ArrowLeft size={12} style={{ display: "inline", verticalAlign: "middle" }} /></button></div>
        {todayItems.length ? <div className="task-list">{todayItems.slice(0, 5).map((item) => renderTask(item))}{todayItems.length > 5 && <button className="secondary-button" onClick={() => setView("today")}>نمایش {formatNumber(todayItems.length - 5)} فعالیت دیگر</button>}</div> : <EmptyState title="امروز هنوز برنامه‌ای نداری" copy="یک فعالیت بساز یا یک برنامه تکرارشونده تعریف کن تا جلسات آینده به‌صورت خودکار در اینجا ظاهر شوند." action={<button className="primary-button" onClick={openNewPlan}><Plus size={14} /> ساخت اولین برنامه</button>} />}
      </section>
      <section className="panel">
        <div className="panel-header"><div><div className="panel-title">قدم بعدی</div><div className="panel-subtitle">فعالیت بعدی در برنامه امروز</div></div><span style={{ color: "var(--primary)" }}><Zap size={17} /></span></div>
        {nextTask ? <><div style={{ background: "var(--primary-soft)", borderRadius: 13, padding: 16, marginBottom: 16 }}><div style={{ color: "var(--primary)", fontSize: 11, fontWeight: 900 }}>{categoryFor(nextTask.categoryId)?.name ?? "فعالیت"}</div><div style={{ fontSize: 17, fontWeight: 900, marginTop: 9 }}>{nextTask.title}</div><div style={{ color: "var(--text-soft)", fontSize: 12, marginTop: 8, display: "flex", gap: 13 }}><span><Clock3 size={12} style={{ display: "inline", verticalAlign: "middle" }} /> {nextTask.startTime}</span><span>{formatDuration(nextTask.durationMinutes)}</span></div></div><button className="primary-button" style={{ width: "100%" }} onClick={() => void toggleTimer(nextTask)}><Play size={14} /> شروع تمرکز</button></> : <EmptyState title="فعلاً فعالیت بعدی مشخص نیست" copy="وقتی فعالیتی برای ادامه روز داشته باشی، اینجا نمایش داده می‌شود." />}
      </section>
    </div>
    <div className="grid-two">
      <section className="panel"><div className="panel-header"><div><div className="panel-title">ریتم هفتگی</div><div className="panel-subtitle">مقایسه فعالیت‌های برنامه‌ریزی‌شده و تکمیل‌شده</div></div><button className="text-link" onClick={() => setView("analytics")}>تحلیل کامل</button></div>{weeklyChart.some((item) => item.planned > 0 || item.done > 0) ? <><div className="chart-wrap" style={{ height: 225 }}><ResponsiveContainer width="100%" height="100%"><BarChart data={weeklyChart} barGap={5} margin={{ top: 12, right: 5, left: 0, bottom: 3 }}><CartesianGrid stroke="var(--line)" strokeDasharray="3 4" vertical={false} /><XAxis dataKey="day" tick={{ fill: "var(--text-soft)", fontSize: 14 }} tickMargin={8} axisLine={false} tickLine={false} /><YAxis allowDecimals={false} tick={{ fill: "var(--text-soft)", fontSize: 13 }} axisLine={false} tickLine={false} width={30} /><Tooltip contentStyle={{ background: "var(--surface-raised)", border: "1px solid var(--line-strong)", borderRadius: 12, fontSize: 14, direction: "rtl" }} /><Bar dataKey="planned" name="برنامه‌ریزی‌شده" fill="#d9d5ff" radius={[5, 5, 0, 0]} maxBarSize={20} /><Bar dataKey="done" name="تکمیل‌شده" fill="#6d5ce8" radius={[5, 5, 0, 0]} maxBarSize={20} /></BarChart></ResponsiveContainer></div><div className="chart-legend"><span><i className="legend-dot" style={{ background: "#d9d5ff" }} /> برنامه‌ریزی‌شده</span><span><i className="legend-dot" style={{ background: "#6d5ce8" }} /> تکمیل‌شده</span></div></> : <EmptyState title="هنوز داده‌ای برای این نمودار نیست" copy="پس از تعریف برنامه‌ها، ریتم هفتگی‌ات در این بخش نمایش داده می‌شود." />}</section>
      <section className="panel"><div className="panel-header"><div><div className="panel-title">تقسیم زمان بر اساس دسته</div><div className="panel-subtitle">زمان ثبت‌شده برای فعالیت‌های تکمیل‌شده</div></div><span style={{ color: "var(--text-faint)" }}><Activity size={16} /></span></div>{categoryChart.length ? <><div className="chart-wrap" style={{ height: 165 }}><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={categoryChart} dataKey="value" nameKey="name" innerRadius={47} outerRadius={72} paddingAngle={3} stroke="none">{categoryChart.map((item) => <Cell key={item.name} fill={item.color} />)}</Pie><Tooltip formatter={(value) => [`${formatNumber(Number(value))} دقیقه`, "زمان"]} contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 10, fontSize: 14, direction: "rtl" }} /></PieChart></ResponsiveContainer></div><div className="category-list">{categoryChart.slice(0, 3).map((item) => <div className="category-item" key={item.name}><span className="category-icon" style={{ background: `${item.color}18` }}>{item.icon}</span><div><div className="category-name">{item.name}</div><div className="category-detail">زمان ثبت‌شده</div></div><div className="category-value">{formatNumber(item.value)} دقیقه</div></div>)}</div></> : <EmptyState title="هنوز داده‌ای برای تحلیل نیست" copy="بعد از تکمیل فعالیت‌ها و ثبت زمان واقعی، توزیع زمان اینجا نمایش داده می‌شود." />}</section>
    </div>
    <section className="panel"><div className="panel-header"><div><div className="panel-title">برنامه‌های فعال</div><div className="panel-subtitle">{formatNumber(activePlans.length)} الگوی تکرارشونده در حال اجرا</div></div><button className="text-link" onClick={() => setView("plans")}>مدیریت برنامه‌ها</button></div>{activePlans.length ? <div className="plan-grid">{activePlans.slice(0, 3).map((plan) => <div className="plan-card" key={plan.id}><div className="plan-card-top"><div className="plan-card-icon" style={{ background: categoryFor(plan.categoryId)?.tint ?? "var(--primary-soft)" }}>{categoryFor(plan.categoryId)?.icon ?? "✨"}</div><span className="storage-dot" /></div><div className="plan-card-title">{plan.title}</div><div className="plan-card-description">{plan.description || categoryFor(plan.categoryId)?.name}</div><div className="plan-meta-grid"><div><div className="plan-meta-label">تکرار</div><div className="plan-meta-value">{frequencyLabel(plan.frequency)}</div></div><div><div className="plan-meta-label">زمان</div><div className="plan-meta-value" dir="ltr">{plan.startTime} · {plan.durationMinutes}m</div></div></div></div>)}</div> : <EmptyState title="هنوز برنامه‌ای تعریف نشده" copy="برای مدیریت خودکار فعالیت‌ها، یک برنامه تکرارشونده بساز." action={<button className="primary-button" onClick={openNewPlan}><Plus size={14} /> ساخت برنامه</button>} />}</section>
  </div>;

  const renderToday = () => <div className="content-stack"><div className="section-heading"><div><h2>برنامه روزانه</h2><p>{formatPersianFullDate(parseISODate(selectedDate))} · برنامه‌ها با زمان‌بندی دقیق</p></div><button className="secondary-button" onClick={() => setSelectedDate(today)}><RotateCcw size={13} /> بازگشت به امروز</button></div><div className="panel"><div className="panel-header"><div><div className="panel-title">فعالیت‌های {selectedDate === today ? "امروز" : formatPersianDate(selectedDate)}</div><div className="panel-subtitle">{formatNumber(selectedItems.length)} فعالیت · {formatDuration(selectedItems.reduce((sum, item) => sum + item.durationMinutes, 0))} زمان برنامه‌ریزی‌شده</div></div><button className="primary-button" onClick={openNewPlan}><Plus size={13} /> برنامه جدید</button></div>{selectedItems.length ? <><div className="progress-track" style={{ marginBottom: 15 }}><div className="progress-fill" style={{ width: `${selectedItems.length ? selectedItems.filter((item) => item.status === "done").length / selectedItems.length * 100 : 0}%` }} /></div><div className="task-list">{selectedItems.map((item) => renderTask(item, true))}</div></> : <EmptyState title="برای این روز فعالیتی ثبت نشده" copy="می‌توانی یک فعالیت موردی را از طریق ساخت برنامه به تقویم اضافه کنی یا روز دیگری را انتخاب کنی." action={<button className="primary-button" onClick={openNewPlan}><Plus size={14} /> ساخت برنامه جدید</button>} />}</div><div className="grid-two"><div className="panel"><div className="panel-title">خلاصه روز</div><div className="stats-grid" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))", marginTop: 14 }}><StatCard label="تکمیل‌شده" value={formatNumber(selectedItems.filter((item) => item.status === "done").length)} note="فعالیت" icon={CheckCheck} tone="green" /><StatCard label="در انتظار" value={formatNumber(selectedItems.filter((item) => item.status === "pending").length)} note="فعالیت" icon={Clock3} tone="orange" /></div></div><div className="panel"><div className="panel-title">میانبر</div><p style={{ color: "var(--text-soft)", fontSize: 12, lineHeight: 2, margin: "10px 0 14px" }}>برای ثبت زمان واقعی، تایمر هر فعالیت را شروع کن. با Refresh هم تایمر فعال و زمان شروع آن حفظ می‌شود.</p><button className="secondary-button" onClick={() => setView("analytics")}><TrendingUp size={13} /> مشاهده گزارش عملکرد</button></div></div></div>;

  const renderPlans = () => {
    const filteredPlans = plans.filter((plan) => (planFilter === "all" || (planFilter === "active" ? plan.active : !plan.active)) && (!search.trim() || plan.title.toLowerCase().includes(search.toLowerCase())));
    return <div className="content-stack"><div className="section-heading"><div><h2>برنامه‌های تکرارشونده</h2><p>الگوهای ثابت زندگی‌ات را تعریف کن و تولید جلسات را به سیستم بسپار.</p></div><button className="primary-button" onClick={openNewPlan}><Plus size={14} /> ساخت برنامه</button></div><div className="panel"><div className="panel-header"><div className="filter-row"><button className={`filter-chip ${planFilter === "all" ? "active" : ""}`} onClick={() => setPlanFilter("all")}>همه ({formatNumber(plans.length)})</button><button className={`filter-chip ${planFilter === "active" ? "active" : ""}`} onClick={() => setPlanFilter("active")}>فعال ({formatNumber(activePlans.length)})</button><button className={`filter-chip ${planFilter === "paused" ? "active" : ""}`} onClick={() => setPlanFilter("paused")}>متوقف</button></div><div style={{ position: "relative", width: 180 }}><Search size={13} style={{ position: "absolute", right: 10, top: 10, color: "var(--text-faint)" }} /><input className="form-control" style={{ paddingRight: 30, paddingTop: 8, paddingBottom: 8 }} placeholder="جست‌وجوی برنامه..." value={search} onChange={(e) => setSearch(e.target.value)} /></div></div>{filteredPlans.length ? <div className="plan-grid">{filteredPlans.map((plan) => { const cat = categoryFor(plan.categoryId); const future = occurrences.filter((item) => item.planId === plan.id && item.date >= today).length; return <div className="plan-card" key={plan.id}><div className="plan-card-top"><div className="plan-card-icon" style={{ background: cat?.tint ?? "var(--primary-soft)" }}>{cat?.icon ?? "✨"}</div><span style={{ color: plan.active ? "var(--green)" : "var(--text-faint)", fontSize: 11, fontWeight: 900 }}>{plan.active ? "● فعال" : "● متوقف"}</span></div><div className="plan-card-title">{plan.title}</div><div className="plan-card-description">{plan.description || cat?.name}</div><div className="plan-meta-grid"><div><div className="plan-meta-label">الگوی تکرار</div><div className="plan-meta-value">{plan.frequency === "weekly" ? plan.weekdays.map((day) => WEEKDAYS.find((item) => item.js === day)?.name).join("، ") : frequencyLabel(plan.frequency)}</div></div><div><div className="plan-meta-label">ساعت و مدت</div><div className="plan-meta-value" dir="ltr">{plan.startTime} · {plan.durationMinutes}m</div></div><div><div className="plan-meta-label">بازه</div><div className="plan-meta-value">{formatPersianDate(plan.startDate)} تا {plan.endDate ? formatPersianDate(plan.endDate) : "بدون پایان"}</div></div><div><div className="plan-meta-label">جلسات آینده ساخته‌شده</div><div className="plan-meta-value">{formatNumber(future)} جلسه</div></div></div><div className="plan-card-actions"><button className="secondary-button" onClick={() => openEditPlan(plan)}>ویرایش</button><button className="secondary-button" onClick={() => void togglePlan(plan)}>{plan.active ? "توقف" : "فعال‌سازی"}</button><button className="secondary-button" onClick={() => void deletePlan(plan)} style={{ color: "var(--red)" }}><Trash2 size={12} /> حذف</button></div></div>; })}</div> : <EmptyState title="برنامه‌ای پیدا نشد" copy="فیلتر یا عبارت جست‌وجو را تغییر بده، یا یک برنامه جدید بساز." action={<button className="primary-button" onClick={openNewPlan}><Plus size={14} /> ساخت برنامه</button>} />}</div><div className="panel" style={{ background: "var(--surface-soft)" }}><div style={{ display: "flex", alignItems: "start", gap: 10 }}><ShieldCheck size={18} color="var(--green)" /><div><div className="panel-title">سوابق جلسات امن می‌مانند</div><div className="panel-subtitle" style={{ lineHeight: 2 }}>توقف یا حذف تعریف یک برنامه، جلسات ثبت‌شده در گذشته را پاک نمی‌کند. جلسات آینده نیز فقط به‌صورت بازه‌ای تولید می‌شوند تا مرورگر بی‌دلیل با هزاران رکورد پر نشود.</div></div></div></div></div>;
  };

  const renderCalendar = () => <div className="content-stack"><div className="section-heading"><div><h2>تقویم فعالیت‌ها</h2><p>توزیع جلسات را در نمای ماهانه ببین و هر روز را برای جزئیات انتخاب کن.</p></div><button className="primary-button" onClick={openNewPlan}><Plus size={14} /> برنامه جدید</button></div><div className="panel calendar-panel"><div className="calendar-head"><div className="calendar-month">{calendarMonthName}</div><div className="calendar-nav"><button className="icon-button" onClick={() => setCalendarMonth((date) => shiftPersianMonth(date, -1))}><ChevronRight size={16} /></button><button className="secondary-button" onClick={() => { setCalendarMonth(new Date()); setSelectedDate(today); }}>امروز</button><button className="icon-button" onClick={() => setCalendarMonth((date) => shiftPersianMonth(date, 1))}><ChevronLeft size={16} /></button></div></div><div className="calendar-grid">{WEEKDAYS.map((day) => <div className="calendar-weekday" key={day.js}>{day.name}</div>)}{calendarDays.map((day) => { const key = toISODate(day); const items = occurrences.filter((item) => item.date === key); const sameMonth = isSamePersianMonth(day, calendarMonth); return <button key={key} className={`calendar-day ${sameMonth ? "" : "muted"} ${key === today ? "today" : ""} ${key === selectedDate ? "selected" : ""}`} onClick={() => { setSelectedDate(key); }}><div className="calendar-number">{getPersianDayNumber(day)}</div><div className="calendar-dots">{items.slice(0, 5).map((item) => <i key={item.id} className="calendar-dot" style={{ background: categoryFor(item.categoryId)?.color ?? "var(--primary)" }} />)}</div>{items.length > 0 && <div className="calendar-count">{formatNumber(items.length)} فعالیت</div>}</button>; })}</div><div className="chart-legend" style={{ marginTop: 15 }}>{categories.slice(0, 5).map((category) => <span key={category.id}><i className="legend-dot" style={{ background: category.color }} />{category.name}</span>)}</div></div><div className="panel"><div className="panel-header"><div><div className="panel-title">جلسات انتخاب‌شده</div><div className="panel-subtitle">{formatPersianFullDate(parseISODate(selectedDate))}</div></div><button className="text-link" onClick={() => setView("today")}>نمای کامل روز</button></div>{selectedItems.length ? <div className="task-list">{selectedItems.map((item) => renderTask(item, true))}</div> : <EmptyState title="این روز جلسه‌ای ندارد" copy="روز دیگری را در تقویم انتخاب کن." />}</div></div>;

  const renderAnalytics = () => {
    const doneAll = occurrences.filter((item) => item.status === "done");
    const dueOccurrences = occurrences.filter((item) => item.date <= today);
    const doneMinutes = doneAll.reduce((sum, item) => sum + item.spentSeconds / 60, 0);
    const duePlannedMinutes = dueOccurrences.reduce((sum, item) => sum + item.durationMinutes, 0);
    const completionRate = dueOccurrences.length
      ? Math.round(doneAll.filter((item) => item.date <= today).length / dueOccurrences.length * 100)
      : 0;
    const categoryTotal = categoryChart.reduce((sum, item) => sum + item.value, 0);
    const activeChartHasData = analyticsChart.some((item) => item.planned > 0 || item.done > 0);
    const weekHasData = weeklyChart.some((item) => item.planned > 0 || item.minutes > 0);
    const bestDay = [...weeklyChart].sort((a, b) => b.minutes - a.minutes)[0];
    const timedSessions = doneAll.filter((item) => item.spentSeconds > 0);
    const averageSessionMinutes = timedSessions.length ? Math.round(doneMinutes / timedSessions.length) : 0;

    return (
      <div className="content-stack analytics-page">
        <div className="section-heading">
          <div>
            <h2>مرکز تحلیل عملکرد</h2>
            <p>تصویر دقیق‌تری از زمان، استمرار و نحوه استفاده‌ات از روزها.</p>
          </div>
          <span className="analytics-live-label"><i /> داده‌های ذخیره‌شده در همین دستگاه</span>
        </div>

        <div className="stats-grid analytics-kpis">
          <StatCard label="جلسات تکمیل‌شده" value={formatNumber(doneAll.length)} note="تمام سوابق تکمیل‌شده" icon={CheckCheck} tone="green" />
          <StatCard label="زمان تمرکز ثبت‌شده" value={`${formatNumber(Math.round(doneMinutes / 60 * 10) / 10)} ساعت`} note="بر اساس تایمر واقعی" icon={Timer} tone="violet" />
          <StatCard label="نرخ انجام به‌موقع" value={`${formatNumber(completionRate)}٪`} note="از جلسات سررسیدشده تا امروز" icon={Gauge} tone="blue" />
          <StatCard label="زمان برنامه‌ریزی‌شده" value={`${formatNumber(Math.round(duePlannedMinutes / 60 * 10) / 10)} ساعت`} note="جلسات سررسیدشده تا امروز" icon={Clock3} tone="orange" />
        </div>

        <div className="analytics-grid analytics-main-grid">
          <section className="panel analytics-panel analytics-trend-panel">
            <div className="panel-header analytics-panel-header">
              <div>
                <div className="panel-title">روند برنامه‌ریزی و تکمیل</div>
                <div className="panel-subtitle">مقایسه تعداد جلسات برنامه‌ریزی‌شده با جلسات انجام‌شده</div>
              </div>
              <select className="form-control analytics-period-select" value={analyticsPeriod} onChange={(e) => setAnalyticsPeriod(e.target.value as "week" | "month" | "year")}>
                <option value="week">هفته جاری</option>
                <option value="month">ماه جاری</option>
                <option value="year">سال جاری</option>
              </select>
            </div>
            {activeChartHasData ? (
              <>
                <div className="chart-wrap analytics-trend-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={analyticsChart} margin={{ top: 14, right: 10, left: 0, bottom: 4 }}>
                      <defs>
                        <linearGradient id="plannedFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#a8a0ff" stopOpacity={0.28} />
                          <stop offset="95%" stopColor="#a8a0ff" stopOpacity={0.015} />
                        </linearGradient>
                        <linearGradient id="completedFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#24ad82" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#24ad82" stopOpacity={0.01} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="var(--line)" strokeDasharray="4 5" vertical={false} />
                      <XAxis dataKey="day" tick={{ fill: "var(--text-soft)", fontSize: 14 }} tickMargin={11} axisLine={false} tickLine={false} minTickGap={8} />
                      <YAxis allowDecimals={false} tick={{ fill: "var(--text-soft)", fontSize: 14 }} axisLine={false} tickLine={false} width={34} />
                      <Tooltip
                        contentStyle={{ background: "var(--surface-raised)", border: "1px solid var(--line-strong)", borderRadius: 13, fontSize: 14, direction: "rtl", boxShadow: "var(--shadow)" }}
                        itemStyle={{ padding: "2px 0" }}
                        labelStyle={{ color: "var(--text)", fontWeight: 800, marginBottom: 7 }}
                        formatter={(value, name) => [formatNumber(Number(value)), String(name ?? "")] }
                      />
                      <Legend verticalAlign="top" align="right" height={36} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 14, color: "var(--text-soft)" }} />
                      <Area type="monotone" dataKey="planned" name="برنامه‌ریزی‌شده" stroke="#9288f5" strokeWidth={2.5} fill="url(#plannedFill)" activeDot={{ r: 5, strokeWidth: 0 }} />
                      <Area type="monotone" dataKey="done" name="تکمیل‌شده" stroke="#24ad82" strokeWidth={2.8} fill="url(#completedFill)" activeDot={{ r: 5, strokeWidth: 0 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="analytics-chart-footnote"><span><i className="legend-dot" style={{ background: "#9288f5" }} /> تعداد جلسات تعریف‌شده</span><span><i className="legend-dot" style={{ background: "#24ad82" }} /> تعداد جلسات انجام‌شده</span></div>
              </>
            ) : (
              <EmptyState title="هنوز داده‌ای برای این بازه وجود ندارد" copy="بعد از تعریف برنامه و ثبت جلسات، روند عملکردت در این نمودار نمایش داده می‌شود." />
            )}
          </section>

          <section className="panel analytics-panel analytics-category-panel">
            <div className="panel-header">
              <div>
                <div className="panel-title">توزیع زمان مفید</div>
                <div className="panel-subtitle">سهم هر دسته از زمان ثبت‌شده با تایمر</div>
              </div>
              <span className="analytics-panel-icon"><Activity size={17} /></span>
            </div>
            {categoryChart.length ? (
              <>
                <div className="donut-chart-shell">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={categoryChart} dataKey="value" nameKey="name" innerRadius="66%" outerRadius="88%" paddingAngle={3} stroke="none" cornerRadius={5}>
                        {categoryChart.map((item) => <Cell key={item.name} fill={item.color} />)}
                      </Pie>
                      <Tooltip
                        formatter={(value) => [`${formatNumber(Number(value))} دقیقه`, "زمان ثبت‌شده"]}
                        contentStyle={{ background: "var(--surface-raised)", border: "1px solid var(--line-strong)", borderRadius: 12, fontSize: 14, direction: "rtl", boxShadow: "var(--shadow)" }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="donut-center"><strong>{formatNumber(Math.round(categoryTotal / 60 * 10) / 10)}</strong><span>ساعت مفید</span></div>
                </div>
                <div className="analytics-category-legend">
                  {categoryChart.map((item) => (
                    <div className="analytics-category-row" key={item.name}>
                      <span className="analytics-category-color" style={{ background: item.color }} />
                      <span className="analytics-category-label">{item.icon} {item.name}</span>
                      <strong>{formatNumber(categoryTotal ? Math.round(item.value / categoryTotal * 100) : 0)}٪</strong>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState title="هنوز زمان ثبت‌شده‌ای نداریم" copy="تایمر فعالیت‌ها را اجرا کن و پس از ثبت زمان، سهم هر دسته را اینجا ببین." />
            )}
          </section>
        </div>

        <div className="analytics-grid analytics-secondary-grid">
          <section className="panel analytics-panel">
            <div className="panel-header">
              <div>
                <div className="panel-title">زمان تمرکز در طول هفته</div>
                <div className="panel-subtitle">دقایق واقعی ثبت‌شده در هر روز این هفته</div>
              </div>
              <span className="analytics-panel-icon"><Timer size={17} /></span>
            </div>
            {weekHasData ? (
              <div className="chart-wrap analytics-week-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={weeklyChart} margin={{ top: 16, right: 5, left: 0, bottom: 3 }} barSize={24}>
                    <CartesianGrid stroke="var(--line)" strokeDasharray="4 5" vertical={false} />
                    <XAxis dataKey="day" tick={{ fill: "var(--text-soft)", fontSize: 14 }} tickMargin={10} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "var(--text-soft)", fontSize: 14 }} axisLine={false} tickLine={false} width={38} />
                    <Tooltip formatter={(value) => [`${formatNumber(Math.round(Number(value)))} دقیقه`, "زمان تمرکز"]} contentStyle={{ background: "var(--surface-raised)", border: "1px solid var(--line-strong)", borderRadius: 12, fontSize: 14, direction: "rtl", boxShadow: "var(--shadow)" }} />
                    <Bar dataKey="minutes" name="زمان تمرکز" fill="#7568ed" radius={[7, 7, 2, 2]} maxBarSize={32} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState title="هنوز فعالیتی در این هفته ثبت نشده" copy="پس از شروع برنامه‌ها، زمان تمرکز روزانه در این بخش مقایسه می‌شود." />
            )}
          </section>

          <section className="panel analytics-panel analytics-insights-panel">
            <div className="panel-header">
              <div>
                <div className="panel-title">شاخص‌های این هفته</div>
                <div className="panel-subtitle">خلاصه‌ای از عملکرد ثبت‌شده</div>
              </div>
              <span className="analytics-panel-icon"><Gauge size={17} /></span>
            </div>
            <div className="insight-list">
              <div className="insight-item"><span>پربازده‌ترین روز</span><strong>{bestDay && bestDay.minutes > 0 ? bestDay.day : "—"}</strong></div>
              <div className="insight-item"><span>میانگین زمان جلسه‌های تایمردار</span><strong>{timedSessions.length ? `${formatNumber(averageSessionMinutes)} دقیقه` : "—"}</strong></div>
              <div className="insight-item"><span>دسته‌بندی‌های دارای زمان ثبت‌شده</span><strong>{formatNumber(categoryChart.length)}</strong></div>
              <div className="insight-item"><span>جلسات سررسیدشده</span><strong>{formatNumber(dueOccurrences.length)}</strong></div>
            </div>
            <div className="insight-note"><TrendingUp size={16} /><span>برای تحلیل دقیق‌تر، تایمر را هنگام شروع هر فعالیت فعال کن؛ تکمیل دستی کار به‌تنهایی زمان واقعی را تخمین نمی‌زند.</span></div>
          </section>
        </div>
      </div>
    );
  };

  const goalProgress = (goal: Goal) => {
    const now = new Date();
    const range = goal.period === "week" ? getWeekRange(now) : { start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 0) };
    const minutes = occurrences.filter((item) => item.status === "done" && item.categoryId === goal.categoryId && parseISODate(item.date) >= range.start && parseISODate(item.date) <= range.end).reduce((sum, item) => sum + (item.spentSeconds / 60), 0);
    return { minutes, percent: Math.min(100, Math.round(minutes / goal.targetMinutes * 100)) };
  };

  const renderGoals = () => <div className="content-stack"><div className="section-heading"><div><h2>هدف‌های قابل اندازه‌گیری</h2><p>برای هر حوزه، یک هدف زمانی مشخص تعریف کن و روند پیشرفت را ببین.</p></div></div><div className="panel"><div className="panel-title">افزودن هدف ماهانه</div><form onSubmit={(e) => void addGoal(e)} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr auto", gap: 9, marginTop: 14 }}><input className="form-control" placeholder="مثلاً ۲۰ ساعت مطالعه شبکه" value={newGoalTitle} onChange={(e) => setNewGoalTitle(e.target.value)} /><select className="form-control" value={newGoalCategory} onChange={(e) => setNewGoalCategory(e.target.value)} disabled={!categories.length}><option value="">{categories.length ? "دسته‌بندی" : "ابتدا دسته‌بندی بساز"}</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input className="form-control numeric-input" type="text" inputMode="numeric" pattern="[0-9۰-۹٠-٩]*" dir="ltr" autoComplete="off" placeholder="ساعت هدف" value={newGoalHours} onChange={(e) => setNewGoalHours(numericDraft(e.target.value))} /><button className="primary-button" type="submit"><Plus size={13} /> افزودن</button></form></div>{goals.length ? <div className="plan-grid">{goals.map((goal) => { const category = categoryFor(goal.categoryId); const progressValue = goalProgress(goal); return <div className="goal-card" key={goal.id}><div className="goal-top"><div><div className="goal-title">{goal.title}</div><div className="goal-amount">{category?.icon} {category?.name} · هدف ماهانه</div></div><div className="goal-percent">{formatNumber(progressValue.percent)}٪</div></div><div className="goal-progress"><div className="progress-track"><div className="progress-fill" style={{ width: `${progressValue.percent}%`, background: category?.color ?? "var(--primary)" }} /></div><div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, color: "var(--text-faint)", fontSize: 11 }}><span>{formatNumber(Math.round(progressValue.minutes / 60 * 10) / 10)} ساعت انجام‌شده</span><span>{formatNumber(goal.targetMinutes / 60)} ساعت هدف</span></div></div><div style={{ display: "flex", justifyContent: "end", marginTop: 12 }}><button className="task-more" onClick={() => void deleteGoal(goal)}><Trash2 size={14} /></button></div></div>; })}</div> : <div className="panel"><EmptyState title="هنوز هدفی تعریف نکرده‌ای" copy="برای مثال هدف بگذار در ماه ۲۰ ساعت مطالعه کنی یا ۱۲ جلسه ورزش داشته باشی." /></div>}</div>;

  const renderCategories = () => <div className="content-stack"><div className="section-heading"><div><h2>دسته‌بندی‌ها</h2><p>رنگ و نشانه اختصاصی برای هر بخش از زندگی‌ات انتخاب کن.</p></div></div><div className="panel"><div className="panel-title">ساخت دسته‌بندی جدید</div><form className="category-create-form" onSubmit={(e) => void addCategory(e)}><input className="form-control category-name-control" placeholder="نام دسته‌بندی" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} /><input className="form-control category-icon-control" value={newCategoryIcon} onChange={(e) => setNewCategoryIcon(e.target.value)} aria-label="آیکون" /><input className="form-control category-color-control" type="color" value={newCategoryColor} onChange={(e) => setNewCategoryColor(e.target.value)} aria-label="رنگ" style={{ padding: 4, height: 44 }} /><button className="primary-button category-submit" type="submit"><Plus size={15} /> ساخت دسته‌بندی</button></form></div>{categories.length ? <div className="plan-grid">{categories.map((category) => { const count = occurrences.filter((item) => item.categoryId === category.id).length; const categoryPlans = plans.filter((plan) => plan.categoryId === category.id).length; return <div className="plan-card" key={category.id}><div className="plan-card-top"><div className="plan-card-icon" style={{ background: category.tint }}>{category.icon}</div><button className="task-more" onClick={() => void deleteCategory(category)} title="حذف دسته"><Trash2 size={14} /></button></div><div className="plan-card-title">{category.name}</div><div className="plan-card-description">{formatNumber(categoryPlans)} برنامه · {formatNumber(count)} جلسه در تقویم</div><div style={{ height: 4, background: category.color, borderRadius: 8, marginTop: 15, opacity: .85 }} /></div>; })}</div> : <div className="panel"><EmptyState title="هنوز دسته‌بندی‌ای نساخته‌ای" copy="از فرم بالا اولین دسته‌بندی دلخواهت را بساز؛ هیچ دسته آماده‌ای به‌صورت پیش‌فرض اضافه نشده است." /></div>}</div>;

  const renderSettings = () => <div className="content-stack">
    <div className="section-heading"><div><h2>تنظیمات و اطلاعات محلی</h2><p>ظاهر برنامه، اعلان‌ها و نسخه پشتیبان اطلاعات مرورگر را مدیریت کن.</p></div></div>
    <div className="settings-grid">
      <section className="panel">
        <div className="panel-title">ظاهر و تجربه کاربری</div>
        <div className="settings-row"><div><div className="settings-label">حالت تیره</div><div className="settings-help">ظاهر برنامه را برای محیط کم‌نور تغییر بده.</div></div><button className={`switch ${settings.darkMode ? "on" : ""}`} onClick={() => void updateAppSettings({ ...settings, darkMode: !settings.darkMode })} aria-label="تغییر حالت تیره" /></div>
        <div className="settings-row"><div><div className="settings-label">اعلان‌های پس‌زمینه</div><div className="settings-help">یادآوری‌ها از طریق Push و حتی هنگام بسته‌بودن صفحه ارسال می‌شوند.</div></div><button className={`switch ${settings.notificationsEnabled ? "on" : ""}`} onClick={() => settings.notificationsEnabled ? void disableNotifications() : void enableNotifications()} aria-label="تغییر اعلان‌های پس‌زمینه" /></div>
        <div className="settings-row"><div><div className="settings-label">حافظه محلی Chrome</div><div className="settings-help">برنامه‌ها و سوابق در IndexedDB همین مرورگر ذخیره می‌شوند.</div></div><span style={{ color: "var(--green)", fontSize: 11, fontWeight: 900 }}>فعال</span></div>
      </section>
      <section className="panel">
        <div className="panel-title">اتصال اعلان به Vercel</div>
        <p style={{ color: "var(--text-soft)", fontSize: 11, lineHeight: 2, margin: "9px 0 12px" }}>کد دسترسی خصوصی‌ای را که در Environment Variables پروژه Vercel با نام PUSH_API_SECRET ثبت کرده‌ای، فقط یک‌بار در این دستگاه وارد کن.</p>
        <label className="form-field">
          <span className="form-label">کد اتصال اعلان</span>
          <input className="form-control" type="password" dir="ltr" autoComplete="off" spellCheck={false} placeholder="PUSH_API_SECRET" value={pushAccessKeyDraft} onChange={(event) => setPushAccessKeyDraft(event.target.value)} />
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          <button className="secondary-button" type="button" onClick={persistPushAccessKey}>ذخیره کد اتصال</button>
          <button className="primary-button" type="button" onClick={() => void (settings.notificationsEnabled ? disableNotifications() : enableNotifications())}>{settings.notificationsEnabled ? "خاموش‌کردن اعلان‌ها" : "فعال‌سازی اعلان‌ها"}</button>
          {settings.notificationsEnabled && <button className="secondary-button" type="button" onClick={() => void sendTestNotification()}><Bell size={14} /> اعلان آزمایشی</button>}
        </div>
        <div className="settings-help" role="status" aria-live="polite" style={{ marginTop: 12, padding: 10, borderRadius: 10, background: "var(--surface-soft, var(--panel-soft))" }}>{pushSyncStatus}</div>
        <p className="settings-help" style={{ marginTop: 9 }}>کد فقط در حافظه محلی همین دستگاه ذخیره می‌شود و وارد فایل Backup نمی‌شود. برای دستگاه دیگر باید همان کد را جداگانه وارد کنی.</p>
      </section>
    </div>
    <div className="settings-grid">
      <section className="panel">
        <div className="panel-title">پشتیبان‌گیری و بازیابی</div>
        <p style={{ color: "var(--text-soft)", fontSize: 11, lineHeight: 2, margin: "10px 0 14px" }}>برای انتقال اطلاعات یا جلوگیری از دست رفتن آن‌ها، هر چند وقت یک‌بار فایل پشتیبان بگیر. فایل شامل برنامه‌ها، جلسات، دسته‌بندی‌ها و هدف‌هاست.</p>
        <button className="primary-button" style={{ width: "100%" }} onClick={() => void exportBackup()}><ArrowDownToLine size={14} /> دانلود نسخه پشتیبان JSON</button>
        <button className="secondary-button" style={{ width: "100%", marginTop: 8 }} onClick={() => backupInput.current?.click()}><Upload size={14} /> بازیابی از فایل پشتیبان</button>
        <input ref={backupInput} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={(e) => void importBackup(e.target.files?.[0])} />
      </section>
      <section className="panel">
        <div className="panel-title">درباره اعلان‌ها و حریم خصوصی</div>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          <div style={{ display: "flex", gap: 9, alignItems: "start" }}><ShieldCheck size={16} color="var(--green)" /><div><div className="settings-label">بدون سرور اختصاصی</div><div className="settings-help">Vercel Function و سرویس زمان‌بندی QStash فقط زمان اعلان و متن همان یادآوری را پردازش می‌کنند؛ دیتابیس برنامه و سوابق در Chrome باقی می‌مانند.</div></div></div>
          <div style={{ display: "flex", gap: 9, alignItems: "start" }}><CircleHelp size={16} color="var(--orange)" /><div><div className="settings-label">محدوده زمان‌بندی</div><div className="settings-help">برای محدودیت پلن رایگان QStash، یادآوری‌ها تا حدود ۷ روز آینده ثبت می‌شوند. برنامه را دست‌کم هر چند روز یک‌بار باز کن تا پنجره بعدی هم زمان‌بندی شود.</div></div></div>
        </div>
      </section>
    </div>
  </div>;

  if (!ready) return <div className="app-root" style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}><div style={{ textAlign: "center", color: "var(--text-soft)" }}><div className="brand-mark" style={{ margin: "0 auto 14px" }}><Activity size={20} /></div><div style={{ fontWeight: 900, fontSize: 16 }}>Routine OS</div><div style={{ fontSize: 12, marginTop: 7 }}>در حال آماده‌سازی فضای شخصی...</div></div></div>;

  return <div className={`app-root ${settings.darkMode ? "dark" : ""}`}>
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Activity size={20} /></div><div><div className="brand-name">Routine OS</div><div className="brand-sub">PERSONAL LIFE SYSTEM</div></div></div>
        <div className="nav-caption">فضای کاری</div><nav className="nav-list">{NAV_ITEMS.map((item) => { const Icon = item.icon; return <button key={item.id} className={`nav-item ${view === item.id ? "active" : ""}`} onClick={() => setView(item.id)}><span className="nav-icon"><Icon size={16} /></span><span>{item.label}</span>{item.id === "today" && todayPending > 0 && <span className="nav-count">{formatNumber(todayPending)}</span>}</button>; })}</nav>
        <div className="sidebar-bottom"><div className="storage-card"><div className="storage-top"><span>حافظه محلی</span><span className="storage-dot" /></div><div className="storage-copy">اطلاعاتت روی همین مرورگر ذخیره می‌شود. با Refresh از بین نمی‌رود.</div></div><div className="user-mini"><div className="avatar">R</div><div><div className="user-name">فضای شخصی من</div><div className="user-plan">LOCAL WORKSPACE · CHROME</div></div></div></div>
      </aside>
      <main className="main-area">
        <header className="topbar"><div className="topbar-left"><div><div className="page-eyebrow">{viewEyebrow}</div><div className="page-title">{currentViewTitle}</div></div></div><div className="topbar-actions"><PwaInstallButton /><button className="icon-button" title="تغییر تم" onClick={() => void updateAppSettings({ ...settings, darkMode: !settings.darkMode })}>{settings.darkMode ? <Sun size={16} /> : <Moon size={16} />}</button><button className="icon-button" title="فعال‌سازی اعلان‌ها" onClick={() => void enableNotifications()}><Bell size={16} />{!settings.notificationsEnabled && <i className="ping" />}</button><button className="primary-button" onClick={openNewPlan}><Plus size={14} /> برنامه جدید</button></div></header>
        {view === "dashboard" && renderDashboard()}
        {view === "today" && renderToday()}
        {view === "plans" && renderPlans()}
        {view === "calendar" && renderCalendar()}
        {view === "analytics" && renderAnalytics()}
        {view === "goals" && renderGoals()}
        {view === "categories" && renderCategories()}
        {view === "settings" && renderSettings()}
        <footer className="app-footer" dir="rtl">
          <span>طراح و برنامه‌نویس: <strong>امیرسجاد نوری</strong></span>
          <a href="https://nouriverse.vercel.app" target="_blank" rel="noreferrer">nouriverse.vercel.app</a>
        </footer>
      </main>
    </div>
    <nav className="mobile-bottom">{NAV_ITEMS.filter((item) => ["dashboard", "today", "plans", "calendar", "analytics", "categories"].includes(item.id)).map((item) => { const Icon = item.icon; return <button key={item.id} className={`mobile-nav-item ${view === item.id ? "active" : ""}`} onClick={() => setView(item.id)}><Icon size={18} /><span>{item.id === "dashboard" ? "خانه" : item.id === "today" ? "امروز" : item.id === "plans" ? "برنامه‌ها" : item.id === "calendar" ? "تقویم" : item.id === "analytics" ? "تحلیل" : "دسته‌ها"}</span></button>; })}</nav>
    <ActivityModal open={modalOpen} onClose={() => { setModalOpen(false); setEditingPlan(null); }} categories={categories} onSave={(plan) => void savePlan(plan)} initialPlan={editingPlan} />
    {toast && <div className="toast-area"><div className="toast"><Check size={14} color="var(--green)" />{toast}</div></div>}
  </div>;
}
