"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Check } from "lucide-react";
import {
  formatPersianFullDate,
  getPersianDayNumber,
  getPersianMonthGrid,
  getPersianMonthLabel,
  isSamePersianMonth,
  parseISODate,
  shiftPersianMonth,
  toISODate,
} from "@/lib/date";
import { WEEKDAYS } from "@/lib/date";

type JalaliDatePickerProps = {
  value: string;
  onChange: (value: string) => void;
  minDate?: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
};

export default function JalaliDatePicker({
  value,
  onChange,
  minDate,
  placeholder = "انتخاب تاریخ شمسی",
  disabled = false,
  ariaLabel = "انتخاب تاریخ",
}: JalaliDatePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => (value ? parseISODate(value) : new Date()));

  useEffect(() => {
    if (!open && value) setVisibleMonth(parseISODate(value));
  }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const days = useMemo(() => getPersianMonthGrid(visibleMonth), [visibleMonth]);
  const todayKey = toISODate(new Date());
  const selectedKey = value || "";

  const selectDate = (date: Date) => {
    const nextValue = toISODate(date);
    if (minDate && nextValue < minDate) return;
    onChange(nextValue);
    setOpen(false);
  };

  return (
    <div className="jalali-picker" ref={rootRef}>
      <button
        type="button"
        className={`form-control jalali-date-trigger ${open ? "is-open" : ""}`}
        onClick={() => !disabled && setOpen((current) => !current)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={value ? "jalali-date-value" : "jalali-date-placeholder"}>
          {value ? formatPersianFullDate(parseISODate(value)) : placeholder}
        </span>
        <CalendarDays size={17} aria-hidden="true" />
      </button>

      {open && (
        <div className="jalali-date-popover" role="dialog" aria-label="تقویم شمسی" dir="rtl">
          <div className="jalali-date-header">
            <button
              type="button"
              className="jalali-date-nav"
              aria-label="ماه قبل"
              onClick={() => setVisibleMonth((current) => shiftPersianMonth(current, -1))}
            >
              <ChevronRight size={18} />
            </button>
            <strong>{getPersianMonthLabel(visibleMonth)}</strong>
            <button
              type="button"
              className="jalali-date-nav"
              aria-label="ماه بعد"
              onClick={() => setVisibleMonth((current) => shiftPersianMonth(current, 1))}
            >
              <ChevronLeft size={18} />
            </button>
          </div>

          <div className="jalali-date-grid jalali-date-weekdays">
            {WEEKDAYS.map((day) => (
              <span key={day.js}>{day.short}</span>
            ))}
          </div>

          <div className="jalali-date-grid jalali-date-days">
            {days.map((day) => {
              const key = toISODate(day);
              const inMonth = isSamePersianMonth(day, visibleMonth);
              const selected = key === selectedKey;
              const isToday = key === todayKey;
              const beforeMin = Boolean(minDate && key < minDate);
              return (
                <button
                  type="button"
                  key={key}
                  className={[
                    "jalali-date-day",
                    inMonth ? "" : "outside-month",
                    selected ? "selected" : "",
                    isToday ? "today" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => selectDate(day)}
                  disabled={beforeMin}
                  aria-pressed={selected}
                  aria-label={formatPersianFullDate(day)}
                >
                  {getPersianDayNumber(day)}
                  {selected && <Check className="jalali-date-selected-check" size={11} />}
                </button>
              );
            })}
          </div>

          <div className="jalali-date-footer">
            <button type="button" className="jalali-date-today" onClick={() => selectDate(new Date())} disabled={Boolean(minDate && todayKey < minDate)}>
              رفتن به امروز
            </button>
            <button type="button" className="jalali-date-close" onClick={() => setOpen(false)}>
              بستن
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
