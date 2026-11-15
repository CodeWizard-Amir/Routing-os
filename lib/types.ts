export type Frequency = "once" | "daily" | "weekly" | "monthly" | "yearly";
export type OccurrenceStatus = "pending" | "done" | "skipped";

export type Category = {
  id: string;
  name: string;
  icon: string;
  color: string;
  tint: string;
  createdAt: number;
};

export type RoutinePlan = {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  frequency: Frequency;
  interval: number;
  weekdays: number[];
  monthDay: number;
  startDate: string;
  endDate: string | null;
  startTime: string;
  durationMinutes: number;
  reminderMinutes: number;
  active: boolean;
  createdAt: number;
  demo?: boolean;
};

export type Occurrence = {
  id: string;
  planId: string;
  title: string;
  categoryId: string;
  date: string;
  startTime: string;
  durationMinutes: number;
  status: OccurrenceStatus;
  spentSeconds: number;
  startedAt: number | null;
  completedAt: number | null;
  note: string;
  reminderSent?: boolean;
  /** QStash message ID for the current device reminder; device-local and excluded from backups. */
  reminderMessageId?: string;
  reminderScheduledAt?: number;
  reminderSubscriptionEndpoint?: string;
};

export type Goal = {
  id: string;
  title: string;
  categoryId: string;
  targetMinutes: number;
  period: "week" | "month";
  createdAt: number;
};

export type AppSettings = {
  darkMode: boolean;
  notificationsEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  weekStartsOn: 6;
};

export type BackupData = {
  version: 1;
  exportedAt: string;
  categories: Category[];
  plans: RoutinePlan[];
  occurrences: Occurrence[];
  goals: Goal[];
  settings: AppSettings;
};
