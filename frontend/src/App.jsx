import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");

const statusLabels = {
  ready: "Tayyor",
  listening: "Tinglayapti",
  thinking: "Tushunyapti",
  speaking: "Gapiryapti",
  error: "Xatolik"
};

const settingsStorageKey = "ai-secretary-settings-v2";

const voiceModels = [
  { value: "lola", label: "Lola" },
  { value: "shoira", label: "Shoira" },
  { value: "davron-neutral", label: "Davron" },
  { value: "davron-happy", label: "Davron quvnoq" },
  { value: "dilfuza-neutral", label: "Dilfuza" },
  { value: "dilfuza-happy", label: "Dilfuza quvnoq" },
  { value: "fotima-neutral", label: "Fotima" },
  { value: "jahongir-neutral", label: "Jahongir" }
];

const defaultSettings = {
  theme: "light",
  ttsVoiceModel: "lola",
  autoSpeakReplies: true,
  voiceControlEnabled: true,
  taskFollowUpEnabled: false,
  taskFollowUpMinutes: 30
};

function getVoiceLabel(model) {
  return voiceModels.find((item) => item.value === model)?.label || model;
}

function isIosDevice() {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent || "";
  return /iphone|ipad|ipod/i.test(ua) || (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
}

function isMobileDevice() {
  if (typeof window === "undefined") return false;
  return /android|iphone|ipad|ipod/i.test(window.navigator.userAgent || "");
}

function isStandaloneApp() {
  if (typeof window === "undefined") return false;
  return Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true);
}

function getNotificationSupportInfo() {
  if (typeof window === "undefined") {
    return { status: "unsupported", supported: false, message: "" };
  }

  const hostname = window.location.hostname;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
  const isSecure = window.isSecureContext || isLocalhost;

  if (!isSecure) {
    return {
      status: "https_required",
      supported: false,
      message:
        "Telefon brauzerida bildirishnoma ishlashi uchun sayt HTTPS orqali ochilishi kerak. Kompyuterdagi localhost ishlaydi, lekin telefon IP manzili secure hisoblanmaydi."
    };
  }

  if (isIosDevice() && !isStandaloneApp()) {
    return {
      status: "homescreen_required",
      supported: false,
      message: "iPhone yoki iPad'da bildirishnoma uchun ilovani 'Uy ekraniga qo'shish' qilib ochish kerak."
    };
  }

  if (!("Notification" in window)) {
    return {
      status: "unsupported",
      supported: false,
      message: "Bu brauzer bildirishnomani qo'llamaydi."
    };
  }

  return {
    status: window.Notification.permission || "prompt",
    supported: true,
    message: isMobileDevice()
      ? "Telefon brauzerida tizim bildirishnomasi cheklangan bo'lishi mumkin. Ilova ochiq turganda ovoz va vibratsiya eslatmasi ishlaydi."
      : ""
  };
}

function getSpeechRecognitionConstructor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function getSupportedRecorderMimeType() {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/ogg;codecs=opus"
  ];

  return candidates.find((item) => MediaRecorder.isTypeSupported(item)) || "";
}

function getAudioExtensionFromMimeType(mimeType = "") {
  if (/mp4|aac|m4a/i.test(mimeType)) return "m4a";
  if (/ogg/i.test(mimeType)) return "ogg";
  return "webm";
}

function isRecoverableVoiceServiceError(message = "") {
  return /insufficient funds|bulut|browser|failed \((401|402|403|429|5\d\d)\)/i.test(String(message));
}

function formatBrowserSpeechError(error = "") {
  const value = String(error || "").toLowerCase();

  if (value === "network") {
    return "Brauzer nutqni tanish xizmatiga ulanib bo'lmadi. Hozircha matn yozib yuboring yoki boshqa brauzerda sinab ko'ring.";
  }

  if (value === "not-allowed" || value === "service-not-allowed") {
    return "Brauzer nutqni tanishga ruxsat bermadi. Mikrofon va brauzer ruxsatlarini tekshiring.";
  }

  if (value === "language-not-supported") {
    return "Brauzer o'zbek tilidagi nutqni tanishni qo'llamayapti.";
  }

  if (value === "audio-capture") {
    return "Mikrofon topilmadi yoki unga ulanib bo'lmadi.";
  }

  if (value === "startup-failed") {
    return "Brauzer nutqni tanish rejimini ishga tushira olmadi.";
  }

  if (value === "no-speech") {
    return "Ovoz eshitilmadi. Yana bir bor gapirib ko'ring.";
  }

  return `Brauzer nutqni tanishda muammo bo'ldi: ${value || "noma'lum xato"}.`;
}

function shouldDisableBrowserSpeech(error = "") {
  return ["network", "not-allowed", "service-not-allowed", "language-not-supported", "audio-capture"].includes(
    String(error || "").toLowerCase()
  );
}

function normalizeCommandText(text = "") {
  return text
    .toLowerCase()
    .replace(/[’`ʻ‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function loadSettings() {
  if (typeof window === "undefined") return defaultSettings;

  try {
    const raw = window.localStorage.getItem(settingsStorageKey);
    if (!raw) return defaultSettings;

    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return defaultSettings;
  }
}

function formatForDatetimeLocal(date) {
  const value = new Date(date);
  const pad = (num) => String(num).padStart(2, "0");

  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function buildDefaultReminderTime() {
  const date = new Date();
  date.setMinutes(date.getMinutes() + 30);
  date.setSeconds(0, 0);
  return formatForDatetimeLocal(date);
}

function extractVoiceModelFromText(normalizedText) {
  const aliases = {
    lola: ["lola"],
    shoira: ["shoira"],
    "davron-neutral": ["davron neutral", "davron"],
    "davron-happy": ["davron happy", "davron quvnoq"],
    "dilfuza-neutral": ["dilfuza neutral", "dilfuza"],
    "dilfuza-happy": ["dilfuza happy", "dilfuza quvnoq"],
    "fotima-neutral": ["fotima neutral", "fotima"],
    "jahongir-neutral": ["jahongir neutral", "jahongir"]
  };

  for (const [model, names] of Object.entries(aliases)) {
    if (names.some((name) => normalizedText.includes(name))) {
      return model;
    }
  }

  return null;
}

function getGreetingTitle() {
  const hour = new Date().getHours();
  if (hour < 11) return "Xayrli tong";
  if (hour < 18) return "Xayrli kun";
  return "Xayrli kech";
}

function formatPermissionLabel(value = "noma'lum") {
  const labels = {
    granted: "ruxsat bor",
    denied: "bloklangan",
    prompt: "kutilmoqda",
    unsupported: "qo'llab-quvvatlanmaydi",
    https_required: "HTTPS kerak",
    homescreen_required: "uy ekraniga qo'shish kerak",
    qisman: "qisman",
    "noma'lum": "noma'lum"
  };

  return labels[value] || value;
}

function formatHealthLabel(value = "") {
  if (value === "ok") return "ulangan";
  if (value === "down") return "uzilgan";
  return value || "noma'lum";
}

function formatReminderRepeatLabel(repeat) {
  if (!repeat) return "Bir martalik";

  const minutes = Number(repeat);
  if (!Number.isFinite(minutes) || minutes <= 0) return "Takrorlanadi";
  if (minutes === 5) return "Har 5 minut";
  if (minutes === 10) return "Har 10 minut";
  if (minutes === 30) return "Har 30 minut";
  if (minutes === 60) return "Har 1 soat";
  if (minutes === 24 * 60) return "Har kuni";
  if (minutes === 7 * 24 * 60) return "Har hafta";
  return `Har ${minutes} minut`;
}

function formatShortDateTime(value) {
  if (!value) return "Vaqt belgilanmagan";
  return new Date(value).toLocaleString("uz-UZ", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatExpenseAmount(amount = 0, currency = "UZS") {
  const numeric = Number(amount) || 0;
  const formatted = numeric.toLocaleString("uz-UZ", {
    minimumFractionDigits: currency === "USD" && numeric % 1 !== 0 ? 2 : 0,
    maximumFractionDigits: currency === "USD" ? 2 : 0
  });

  return currency === "USD" ? `${formatted} $` : `${formatted} so'm`;
}

function buildExpenseTotalsText(totals = {}) {
  const parts = [];
  if (totals.UZS > 0) parts.push(formatExpenseAmount(totals.UZS, "UZS"));
  if (totals.USD > 0) parts.push(formatExpenseAmount(totals.USD, "USD"));
  return parts.join(" / ") || "Hali yozuv yo'q";
}

function getExpenseRange(period = "today") {
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const start = new Date(end);
  start.setHours(0, 0, 0, 0);

  if (period === "week") {
    start.setDate(start.getDate() - 6);
  } else if (period === "month") {
    start.setDate(1);
  }

  return { start, end };
}

function summarizeExpenses(expenses = [], period = "today") {
  const { start, end } = getExpenseRange(period);
  const totals = { UZS: 0, USD: 0 };
  const items = expenses.filter((expense) => {
    const value = new Date(expense.occurredAt || expense.createdAt).getTime();
    return value >= start.getTime() && value <= end.getTime();
  });

  items.forEach((expense) => {
    const currency = expense.currency === "USD" ? "USD" : "UZS";
    totals[currency] += Number(expense.amount) || 0;
  });

  return { totals, items };
}

function toLocalDateKey(value) {
  const date = new Date(value);
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildExpenseSeries(expenses = [], currency = "UZS", days = 30) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));

  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      key: toLocalDateKey(date),
      label: `${date.getDate()}`,
      value: 0
    };
  });

  expenses.forEach((expense) => {
    if ((expense.currency === "USD" ? "USD" : "UZS") !== currency) return;
    const key = toLocalDateKey(expense.occurredAt || expense.createdAt);
    const bucket = buckets.find((item) => item.key === key);
    if (bucket) {
      bucket.value += Number(expense.amount) || 0;
    }
  });

  return buckets;
}

function buildLinePath(data, width, height, padding) {
  if (data.length === 0) return "";

  const values = data.map((item) => item.value);
  const maxValue = Math.max(...values, 1);
  const stepX = data.length === 1 ? 0 : (width - padding * 2) / (data.length - 1);

  return data
    .map((item, index) => {
      const x = padding + index * stepX;
      const y = height - padding - (item.value / maxValue) * (height - padding * 2);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}

function ExpenseChart({ title, currency, data, stroke }) {
  const width = 320;
  const height = 140;
  const padding = 18;
  const maxValue = Math.max(...data.map((item) => item.value), 0);
  const path = buildLinePath(data, width, height, padding);

  return (
    <div className="card compact-card chart-card">
      <div className="section-head">
        <h2>{title}</h2>
        <span className="section-meta">{currency === "USD" ? "Dollar" : "So'm"}</span>
      </div>

      {maxValue === 0 ? (
        <div className="chart-empty">Hali ma'lumot yo'q.</div>
      ) : (
        <>
          <svg className="expense-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
            <path
              d={`M ${padding} ${height - padding} L ${width - padding} ${height - padding}`}
              fill="none"
              stroke="rgba(122, 139, 170, 0.28)"
              strokeWidth="1"
            />
            <path
              d={path}
              fill="none"
              stroke={stroke}
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div className="chart-meta">
            <strong>Eng yuqori nuqta: {formatExpenseAmount(maxValue, currency)}</strong>
            <span>So'nggi 30 kun</span>
          </div>
        </>
      )}
    </div>
  );
}

function App() {
  const [page, setPage] = useState("home");
  const [status, setStatus] = useState("ready");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("Buyruq ayting, men bajaraman.");
  const [tasks, setTasks] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [draftText, setDraftText] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskFilter, setTaskFilter] = useState("open");
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderTime, setReminderTime] = useState(buildDefaultReminderTime());
  const [reminderFilter, setReminderFilter] = useState("upcoming");
  const [expenseTitle, setExpenseTitle] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCurrency, setExpenseCurrency] = useState("UZS");
  const [settings, setSettings] = useState(loadSettings);
  const [microphoneStatus, setMicrophoneStatus] = useState("noma'lum");
  const [notificationStatus, setNotificationStatus] = useState("noma'lum");
  const [notificationHelpText, setNotificationHelpText] = useState("");
  const [health, setHealth] = useState({});
  const [errorMessage, setErrorMessage] = useState("");
  const [speechInfo, setSpeechInfo] = useState({
    source: "idle",
    model: defaultSettings.ttsVoiceModel,
    error: ""
  });

  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingStreamRef = useRef(null);
  const shouldSendRecordingRef = useRef(false);
  const activePointerIdRef = useRef(null);
  const audioRef = useRef(null);
  const reminderTimersRef = useRef({});
  const taskFollowUpTimerRef = useRef(null);
  const ttsFallbackOnlyRef = useRef(false);
  const voiceCaptureModeRef = useRef("upload");
  const speechRecognitionRef = useRef(null);
  const speechTranscriptRef = useRef("");
  const speechRecognitionEndedRef = useRef(false);
  const speechRecognitionErrorRef = useRef("");
  const browserSpeechUnavailableRef = useRef(false);
  const browserSpeechUnavailableReasonRef = useRef("");
  const recordingMimeTypeRef = useRef("");

  useEffect(() => {
    getTasks();
    getReminders();
    getExpenses();
    checkPermissions();
    pingHealth();
    registerNotificationWorker();
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
    }
  }, [settings]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = settings.theme;
    }
  }, [settings.theme]);

  useEffect(() => {
    setupReminderAlarms();

    return () => {
      Object.values(reminderTimersRef.current).forEach((timer) => clearTimeout(timer));
      reminderTimersRef.current = {};
    };
  }, [reminders, notificationStatus, settings.autoSpeakReplies, settings.ttsVoiceModel]);

  useEffect(() => {
    clearInterval(taskFollowUpTimerRef.current);
    taskFollowUpTimerRef.current = null;

    if (!settings.taskFollowUpEnabled || settings.taskFollowUpMinutes <= 0) {
      return undefined;
    }

    const openTasks = tasks.filter((task) => !task.completed);
    if (openTasks.length === 0) {
      return undefined;
    }

    taskFollowUpTimerRef.current = window.setInterval(async () => {
      const pending = tasks.filter((task) => !task.completed);
      if (pending.length === 0) return;

      const message =
        pending.length === 1
          ? `"${pending[0].title}" vazifasi hali ochiq.`
          : `Sizda ${pending.length} ta ochiq vazifa bor.`;

      setReply(message);

      await showDeviceNotification("Vazifa eslatmasi", message);

      if (settings.autoSpeakReplies) {
        await speakText(message, { force: true });
      }
    }, settings.taskFollowUpMinutes * 60 * 1000);

    return () => {
      clearInterval(taskFollowUpTimerRef.current);
      taskFollowUpTimerRef.current = null;
    };
  }, [tasks, settings.taskFollowUpEnabled, settings.taskFollowUpMinutes, settings.autoSpeakReplies, settings.ttsVoiceModel]);

  async function pingHealth() {
    try {
      const res = await fetch(`${API_BASE}/health`);
      const data = await res.json();
      setHealth(data);
    } catch (err) {
      setHealth({ status: "down", error: err.message });
    }
  }

  async function getTasks() {
    try {
      const res = await fetch(`${API_BASE}/tasks`);
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch {
      setErrorMessage("Vazifalarni yuklab bo'lmadi.");
    }
  }

  async function getReminders() {
    try {
      const res = await fetch(`${API_BASE}/reminders`);
      const data = await res.json();
      setReminders(data.reminders || []);
    } catch {
      setErrorMessage("Eslatmalarni yuklab bo'lmadi.");
    }
  }

  async function getExpenses() {
    try {
      const res = await fetch(`${API_BASE}/expenses`);
      const data = await res.json();
      setExpenses(data.expenses || []);
    } catch {
      setErrorMessage("Xarajatlarni yuklab bo'lmadi.");
    }
  }

  async function checkPermissions() {
    if (navigator.permissions) {
      try {
        const micPerm = await navigator.permissions.query({ name: "microphone" });
        setMicrophoneStatus(micPerm.state);
        micPerm.onchange = () => setMicrophoneStatus(micPerm.state);
      } catch {
        setMicrophoneStatus("qisman");
      }
    }

    const notificationInfo = getNotificationSupportInfo();
    setNotificationStatus(notificationInfo.status);
    setNotificationHelpText(notificationInfo.message || "");
  }

  function updateSetting(key, value) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function registerNotificationWorker() {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !window.isSecureContext) return;

    try {
      await navigator.serviceWorker.register("/sw.js");
    } catch (error) {
      console.warn("Service worker ro'yxatdan o'tmadi", error);
    }
  }

  async function requestNotifications() {
    const notificationInfo = getNotificationSupportInfo();
    setNotificationStatus(notificationInfo.status);
    setNotificationHelpText(notificationInfo.message || "");

    if (!notificationInfo.supported) {
      setErrorMessage(notificationInfo.message || "Bildirishnoma hozir ishlamaydi.");
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      const nextInfo = getNotificationSupportInfo();
      setNotificationStatus(permission);
      setNotificationHelpText(nextInfo.message || "");

      if (permission === "denied") {
        setErrorMessage("Brauzer bildirishnomaga ruxsat bermadi.");
      }
    } catch (error) {
      setErrorMessage(error.message || "Bildirishnoma ruxsatini so'rab bo'lmadi.");
    }
  }

  async function showDeviceNotification(title, body) {
    let shown = false;

    try {
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
        if ("serviceWorker" in navigator) {
          const registration = await navigator.serviceWorker.getRegistration();
          if (registration?.showNotification) {
            await registration.showNotification(title, {
              body,
              tag: "kotiba-ai",
              renotify: true
            });
            shown = true;
          }
        }

        if (!shown) {
          new Notification(title, { body });
          shown = true;
        }
      }
    } catch (error) {
      console.warn("Bildirishnoma ko'rsatilmadi", error);
      if (!notificationHelpText) {
        setNotificationHelpText("Telefon brauzerida tizim bildirishnomasi cheklangan bo'lishi mumkin. Ovoz va vibratsiya eslatmasi ishlaydi.");
      }
    }

    if (!shown && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([140, 90, 140]);
    }

    return shown;
  }

  function setupReminderAlarms() {
    Object.values(reminderTimersRef.current).forEach((timer) => clearTimeout(timer));
    reminderTimersRef.current = {};

    reminders
      .filter((reminder) => !reminder.done)
      .forEach((reminder) => {
        if (!reminder.time) return;

        const due = new Date(reminder.time).getTime();
        let delay = due - Date.now();
        if (delay < 0) delay = 0;

        const fire = async () => {
          const message = `Eslatma: ${reminder.title}`;

          await showDeviceNotification("Eslatma", reminder.title);

          setReply(message);
          if (settings.autoSpeakReplies) {
            await speakText(message, { force: true });
          }

          if (reminder.repeat) {
            const nextDelay = Number(reminder.repeat) * 60 * 1000;
            reminderTimersRef.current[reminder.id] = setTimeout(fire, nextDelay);
          }
        };

        reminderTimersRef.current[reminder.id] = setTimeout(fire, delay);
      });
  }

  async function speakWithBrowserVoice(text, options = {}) {
    const { model = settings.ttsVoiceModel, failSilently = true, providerMessage = "" } = options;

    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setSpeechInfo({
        source: "error",
        model,
        error: providerMessage || "Brauzer ovozi mavjud emas"
      });
      if (!failSilently) {
        setErrorMessage(providerMessage || "Brauzer ovozi mavjud emas.");
      }
      setStatus("ready");
      return { ok: false, source: "error", model, error: providerMessage || "Brauzer ovozi mavjud emas" };
    }

    stopPlayback();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "uz-UZ";
    utterance.onend = () => setStatus("ready");
    utterance.onerror = () => setStatus("ready");
    setSpeechInfo({
      source: "browser",
      model,
      error: providerMessage
    });
    setStatus("speaking");
    window.speechSynthesis.speak(utterance);

    if (providerMessage && !failSilently) {
      setErrorMessage(providerMessage);
    }

    return { ok: true, source: "browser", model };
  }

  async function speakText(text, options = {}) {
    const {
      force = false,
      model = settings.ttsVoiceModel,
      allowBrowserFallback = true,
      failSilently = true
    } = options;

    if (!force && !settings.autoSpeakReplies) {
      setStatus("ready");
      return { ok: true, source: "disabled", model };
    }

    if (allowBrowserFallback && ttsFallbackOnlyRef.current) {
      return speakWithBrowserVoice(text, {
        model,
        failSilently,
        providerMessage: "Bulut ovozi hozir ishlamadi. Brauzer ovozi ishlatilmoqda."
      });
    }

    try {
      const res = await fetch(`${API_BASE}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, model })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.message || data?.error || "TTS xatolik");
      }

      if (!data?.audio) {
        if (data?.fallback === "browser" && allowBrowserFallback) {
          ttsFallbackOnlyRef.current = true;
          return speakWithBrowserVoice(text, {
            model,
            failSilently,
            providerMessage: data?.message || "Bulut ovozi hozir ishlamadi. Brauzer ovozi ishlatilmoqda."
          });
        }

        throw new Error(data?.message || "TTS audio topilmadi.");
      }

      stopPlayback();
      const audioEl = new Audio(data.audio);
      audioRef.current = audioEl;
      ttsFallbackOnlyRef.current = false;
      setSpeechInfo({ source: "uzbekvoice", model, error: "" });
      setStatus("speaking");
      audioEl.onended = () => setStatus("ready");
      audioEl.onerror = () => setStatus("ready");
      await audioEl.play();
      return { ok: true, source: "uzbekvoice", model };
    } catch (err) {
      if (allowBrowserFallback) {
        if (isRecoverableVoiceServiceError(err?.message)) {
          ttsFallbackOnlyRef.current = true;
        }

        return speakWithBrowserVoice(text, {
          model,
          failSilently,
          providerMessage: err?.message || "Bulut ovozi hozir ishlamadi. Brauzer ovozi ishlatilmoqda."
        });
      }

      console.error("TTS fallback ham ishlamadi", err);
      setSpeechInfo({
        source: "error",
        model,
        error: err?.message || "TTS xatolik"
      });
      if (!failSilently) {
        setErrorMessage(err?.message || "Tanlangan ovozni ijro qilib bo'lmadi.");
      }
      setStatus("ready");
      return { ok: false, source: "error", model, error: err?.message || "TTS xatolik" };
    }
  }

  function stopPlayback() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }

    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  async function finalizeSpeechRecognition() {
    const finalTranscript = speechTranscriptRef.current.trim();
    const recognitionError = speechRecognitionErrorRef.current;

    speechRecognitionErrorRef.current = "";
    speechRecognitionEndedRef.current = false;
    speechTranscriptRef.current = "";

    if (!shouldSendRecordingRef.current) {
      setStatus("ready");
      return;
    }

    if (recognitionError && recognitionError !== "no-speech" && recognitionError !== "aborted") {
      if (shouldDisableBrowserSpeech(recognitionError)) {
        browserSpeechUnavailableRef.current = true;
        browserSpeechUnavailableReasonRef.current = recognitionError;
      }

      setReply("Ovozli yuborishda muammo bo'ldi.");
      setStatus("error");
      setErrorMessage(formatBrowserSpeechError(recognitionError));
      return;
    }

    if (!finalTranscript) {
      setReply("Yana bir bor ayting.");
      setStatus("ready");
      return;
    }

    setTranscript(finalTranscript);
    setStatus("thinking");

    try {
      await runAssistant(finalTranscript);
    } catch (error) {
      setReply("Ovozli yuborishda muammo bo'ldi.");
      setStatus("error");
      setErrorMessage(error.message);
    }
  }

  async function startBrowserSpeechRecognition() {
    const SpeechRecognitionCtor = getSpeechRecognitionConstructor();
    if (!SpeechRecognitionCtor || browserSpeechUnavailableRef.current) return false;

    try {
      const recognition = new SpeechRecognitionCtor();
      recognition.lang = "uz-UZ";
      recognition.interimResults = true;
      recognition.continuous = true;
      recognition.maxAlternatives = 1;

      speechTranscriptRef.current = "";
      speechRecognitionErrorRef.current = "";
      speechRecognitionEndedRef.current = false;

      recognition.onresult = (event) => {
        const text = Array.from(event.results)
          .map((result) => result[0]?.transcript || "")
          .join(" ")
          .trim();

        speechTranscriptRef.current = text;
        if (text) {
          setTranscript(text);
        }
      };

      recognition.onerror = (event) => {
        speechRecognitionErrorRef.current = event.error || "noma'lum";
      };

      recognition.onend = () => {
        speechRecognitionRef.current = null;
        speechRecognitionEndedRef.current = true;

        if (shouldSendRecordingRef.current || activePointerIdRef.current === null) {
          void finalizeSpeechRecognition();
        }
      };

      recognition.start();
      speechRecognitionRef.current = recognition;
      voiceCaptureModeRef.current = "browser";
      return true;
    } catch {
      browserSpeechUnavailableRef.current = true;
      browserSpeechUnavailableReasonRef.current = "startup-failed";
      return false;
    }
  }

  async function announceLocalAction(message, options = {}) {
    const { model, alwaysSpeak = false, allowBrowserFallback = true, failSilently = true } = options;

    setReply(message);
    setErrorMessage("");

    if (alwaysSpeak || settings.autoSpeakReplies) {
      await speakText(message, { force: true, model, allowBrowserFallback, failSilently });
    } else {
      setStatus("ready");
    }
  }

  async function addTask() {
    const title = taskTitle.trim();
    if (!title) return;

    try {
      const res = await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Vazifa qo'shib bo'lmadi.");
      }

      setTaskTitle("");
      await getTasks();
      await announceLocalAction(`"${title}" vazifasi qo'shildi.`);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function completeTask(taskId, options = {}) {
    const { silent = false } = options;

    const res = await fetch(`${API_BASE}/tasks/${taskId}/complete`, { method: "PATCH" });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 404) {
        await getTasks();
        return null;
      }
      throw new Error(data.message || data.error || "Vazifani yangilab bo'lmadi.");
    }

    await getTasks();

    if (!silent) {
      await announceLocalAction(`"${data.task.title}" bajarildi deb belgilandi.`);
    }

    return data.task;
  }

  async function addReminder() {
    const title = reminderTitle.trim();
    if (!title || !reminderTime) return;

    try {
      const res = await fetch(`${API_BASE}/reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          time: new Date(reminderTime).toISOString()
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Eslatma qo'shib bo'lmadi.");
      }

      setReminderTitle("");
      setReminderTime(buildDefaultReminderTime());
      await getReminders();
      await announceLocalAction(`"${title}" eslatmasi qo'shildi.`);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function addExpense() {
    const title = expenseTitle.trim();
    const amount = Number(String(expenseAmount).replace(",", "."));
    if (!title || !Number.isFinite(amount)) return;

    try {
      const res = await fetch(`${API_BASE}/expenses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          amount,
          currency: expenseCurrency
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Xarajat qo'shib bo'lmadi.");
      }

      setExpenseTitle("");
      setExpenseAmount("");
      await getExpenses();
      await announceLocalAction(`${formatExpenseAmount(amount, expenseCurrency)} xarajat qo'shildi.`, {
        alwaysSpeak: false
      });
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function toggleReminderDone(reminder, options = {}) {
    const { silent = false } = options;

    const res = await fetch(`${API_BASE}/reminders/${reminder.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: !reminder.done })
    });

    const data = await res.json();
    if (!res.ok) {
      if (res.status === 404) {
        await getReminders();
        if (!silent) {
          await announceLocalAction("Bu eslatma allaqachon o'chirilgan.");
        }
        return null;
      }
      throw new Error(data.message || data.error || "Eslatmani yangilab bo'lmadi.");
    }

    await getReminders();

    if (!silent) {
      await announceLocalAction(
        data.reminder.done
          ? `"${data.reminder.title}" bajarildi.`
          : `"${data.reminder.title}" qayta ochildi.`
      );
    }

    return data.reminder;
  }

  async function deleteReminder(reminderId, options = {}) {
    const { silent = false } = options;

    const res = await fetch(`${API_BASE}/reminders/${reminderId}`, {
      method: "DELETE"
    });

    const data = await res.json();
    if (!res.ok) {
      if (res.status === 404) {
        await getReminders();
        if (!silent) {
          await announceLocalAction("Bu eslatma allaqachon o'chirilgan.");
        }
        return null;
      }
      throw new Error(data.message || data.error || "Eslatmani o'chirib bo'lmadi.");
    }

    await getReminders();

    if (!silent) {
      await announceLocalAction(`"${data.reminder.title}" o'chirildi.`);
    }

    return data.reminder;
  }

  async function deleteAllReminders(options = {}) {
    const { silent = false } = options;

    const res = await fetch(`${API_BASE}/reminders`, {
      method: "DELETE"
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || data.error || "Eslatmalarni tozalab bo'lmadi.");
    }

    await getReminders();

    if (!silent) {
      const count = data.reminders?.length ?? 0;
      await announceLocalAction(count > 0 ? `${count} ta eslatma tozalandi.` : "Tozalanadigan eslatma yo'q.");
    }

    return data.reminders || [];
  }

  async function deleteExpense(expenseId) {
    try {
      const res = await fetch(`${API_BASE}/expenses/${expenseId}`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Xarajatni o'chirib bo'lmadi.");
      }

      await getExpenses();
      await announceLocalAction(`"${data.expense.title}" o'chirildi.`, {
        alwaysSpeak: false
      });
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  async function testSelectedVoice() {
    const voiceLabel = getVoiceLabel(settings.ttsVoiceModel);
    const previewText = `Assalomu alaykum. Hozir ${voiceLabel} ovozi tanlangan.`;

    setReply(`${voiceLabel} ovozi sinovdan o'tmoqda.`);
    setErrorMessage("");
    const result = await speakText(previewText, {
      force: true,
      model: settings.ttsVoiceModel,
      allowBrowserFallback: false,
      failSilently: false
    });

    if (!result?.ok) {
      setReply("Tanlangan ovoz ishlamadi.");
    }
  }

  async function handleLocalVoiceCommand(text) {
    const normalized = normalizeCommandText(text);
    const selectedVoice = extractVoiceModelFromText(normalized);

    if (selectedVoice && /(ovoz|kotiba|sekretar)/.test(normalized)) {
      setSettings((current) => ({ ...current, ttsVoiceModel: selectedVoice }));
      await announceLocalAction(`${getVoiceLabel(selectedVoice)} ovoziga o'tdim.`, {
        model: selectedVoice
      });
      return true;
    }

    if (/(dark mode|dark mod|qorong'i rejim|tungi rejim)/.test(normalized)) {
      setSettings((current) => ({ ...current, theme: "dark" }));
      await announceLocalAction("Tungi ko'rinish yoqildi.");
      return true;
    }

    if (/(light mode|yorug' rejim|kunduzgi rejim|oq rejim)/.test(normalized)) {
      setSettings((current) => ({ ...current, theme: "light" }));
      await announceLocalAction("Och ko'rinish yoqildi.");
      return true;
    }

    if (/(sozlamalar|settings)/.test(normalized) && /(och|open|kir|ko'rsat)/.test(normalized)) {
      setPage("settings");
      await announceLocalAction("Sozlamalar ochildi.");
      return true;
    }

    if (/(tasklar|vazifalar)/.test(normalized) && /(och|open|ko'rsat|kir)/.test(normalized)) {
      setPage("tasks");
      await announceLocalAction("Vazifalar ochildi.");
      return true;
    }

    if (/(eslatmalar|reminderlar)/.test(normalized) && /(och|open|ko'rsat|kir)/.test(normalized)) {
      setPage("reminders");
      await announceLocalAction("Eslatmalar ochildi.");
      return true;
    }

    if (/(xarajatlar|statistika)/.test(normalized) && /(och|open|ko'rsat|kir)/.test(normalized)) {
      setPage("expenses");
      await announceLocalAction("Xarajatlar bo'limi ochildi.");
      return true;
    }

    if (/(bosh sahifa|home)/.test(normalized) && /(och|open|qayt|bor)/.test(normalized)) {
      setPage("home");
      await announceLocalAction("Asosiy sahifaga qaytdim.");
      return true;
    }

    if (/(barcha )?eslatmalar(ni)?/.test(normalized) && /(ochir|o'chir|tozala|bekor qil)/.test(normalized)) {
      await deleteAllReminders({ silent: true });
      await announceLocalAction("Barcha eslatmalar o'chirildi.");
      return true;
    }

    if (/(birinchi|keyingi|ochiq).*(task|vazifa).*(bajarildi|yakunla|tugat)/.test(normalized) || /(task|vazifa).*(bajarildi qil)/.test(normalized)) {
      const pendingTask = tasks.find((task) => !task.completed);
      if (!pendingTask) {
        await announceLocalAction("Ochiq vazifa topilmadi.");
        return true;
      }

      await completeTask(pendingTask.id, { silent: true });
      await announceLocalAction(`"${pendingTask.title}" bajarildi.`);
      return true;
    }

    if (/(tasklar|vazifalar).*(sorab tur|so'rab tur|eslatib tur|qildingizmi)/.test(normalized)) {
      const minutesMatch = normalized.match(/(\d+)\s*(daqiqa|minut)/);
      const minutes = minutesMatch ? Number(minutesMatch[1]) : settings.taskFollowUpMinutes;
      setSettings((current) => ({
        ...current,
        taskFollowUpEnabled: true,
        taskFollowUpMinutes: minutes
      }));
      await announceLocalAction(`Vazifalarni har ${minutes} minutda eslataman.`);
      return true;
    }

    if (/(tasklar|vazifalar).*(sorama|so'ramа|eslatma|to'xtat)/.test(normalized)) {
      setSettings((current) => ({ ...current, taskFollowUpEnabled: false }));
      await announceLocalAction("Vazifa eslatmasi o'chirildi.");
      return true;
    }

    return false;
  }

  async function runAssistant(text) {
    const finalText = text.trim();
    if (!finalText) return;

    setStatus("thinking");
    setErrorMessage("");

    if (settings.voiceControlEnabled) {
      const handled = await handleLocalVoiceCommand(finalText);
      if (handled) {
        return;
      }
    }

    const assistantResp = await fetch(`${API_BASE}/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: finalText })
    });

    const assistantJson = await assistantResp.json();
    if (!assistantResp.ok) {
      throw new Error(assistantJson.message || assistantJson.error || "Yordamchi xatoligi");
    }

    setReply(assistantJson.replyText);

    if (assistantJson.uiResponse) {
      if (assistantJson.uiResponse.tasks) setTasks(assistantJson.uiResponse.tasks);
      if (assistantJson.uiResponse.reminders) setReminders(assistantJson.uiResponse.reminders);
      if (assistantJson.uiResponse.expenses) setExpenses(assistantJson.uiResponse.expenses);
    }

    await speakText(assistantJson.replyText);
    await getTasks();
    await getReminders();
    await getExpenses();
  }

  async function submitTextPrompt() {
    const message = draftText.trim();
    if (!message || status === "thinking" || status === "listening") return;

    setTranscript(message);
    setReply("...");
    setDraftText("");

    try {
      await runAssistant(message);
    } catch (error) {
      setReply("So'rovni bajarib bo'lmadi.");
      setStatus("error");
      setErrorMessage(error.message);
    }
  }

  async function startRecording() {
    if (status === "thinking" || status === "speaking" || mediaRecorderRef.current || speechRecognitionRef.current) return;

    try {
      setStatus("listening");
      setTranscript("");
      setReply("Gapiring, tinglayapman.");
      setErrorMessage("");
      shouldSendRecordingRef.current = false;

      if (typeof MediaRecorder === "undefined") {
        const startedWithBrowser = await startBrowserSpeechRecognition();
        if (startedWithBrowser) {
          return;
        }

        throw new Error("Bu brauzer audio yozishni qo'llamaydi.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;
      const mimeType = getSupportedRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recordingChunksRef.current = [];
      recordingMimeTypeRef.current = recorder.mimeType || mimeType || "";
      voiceCaptureModeRef.current = "upload";

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          if (event.data.type) {
            recordingMimeTypeRef.current = event.data.type;
          }
          recordingChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null;
        mediaRecorderRef.current = null;

        if (!shouldSendRecordingRef.current) {
          recordingChunksRef.current = [];
          setStatus("ready");
          return;
        }

        setStatus("thinking");

        const audioMimeType = recordingMimeTypeRef.current || recordingChunksRef.current[0]?.type || "audio/webm";
        const fileExtension = getAudioExtensionFromMimeType(audioMimeType);
        const blob = new Blob(recordingChunksRef.current, { type: audioMimeType });
        recordingChunksRef.current = [];
        const form = new FormData();
        form.append("audio", blob, `voice.${fileExtension}`);

        try {
          const sttResp = await fetch(`${API_BASE}/stt`, { method: "POST", body: form });
          const sttJson = await sttResp.json();

          if (!sttResp.ok) {
            throw new Error(sttJson.message || sttJson.error || "STT xatolik");
          }

          if (sttJson?.fallback === "browser_speech") {
            if (getSpeechRecognitionConstructor() && !browserSpeechUnavailableRef.current) {
              setReply("Bulut STT ishlamadi. Yana bir marta gapiring, brauzer tinglashi ishlaydi.");
              setStatus("ready");
              setErrorMessage(sttJson.message || "Brauzer tinglash rejimiga o'tildi.");
            } else {
              const browserReason = browserSpeechUnavailableReasonRef.current;
              const browserMessage = browserReason ? formatBrowserSpeechError(browserReason) : "Brauzerda nutqni tanish funksiyasi topilmadi.";

              setReply("Ovozli matnga aylantirish hozir ishlamadi.");
              setStatus("error");
              setErrorMessage(`${sttJson.message || "Bulut STT hozir ishlamadi."} ${browserMessage}`);
            }
            return;
          }

          const finalTranscript = sttJson.transcript;
          if (!finalTranscript || !finalTranscript.trim()) {
            setReply("Yana bir bor ayting.");
            setStatus("ready");
            return;
          }

          setTranscript(finalTranscript);
          await runAssistant(finalTranscript);
        } catch (error) {
          setReply("Ovozli yuborishda muammo bo'ldi.");
          setStatus("error");
          setErrorMessage(error.message);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
    } catch (err) {
      setStatus("error");
      setErrorMessage("Mikrofonga kira olmadi: " + err.message);
    }
  }

  function finishRecording(shouldSend) {
    shouldSendRecordingRef.current = shouldSend;

    if (voiceCaptureModeRef.current === "browser") {
      const recognition = speechRecognitionRef.current;
      if (recognition) {
        try {
          recognition.stop();
        } catch {}
        return;
      }

      if (speechRecognitionEndedRef.current) {
        void finalizeSpeechRecognition();
        return;
      }
    }

    const recorder = mediaRecorderRef.current;

    if (!recorder || recorder.state === "inactive") {
      setStatus("ready");
      return;
    }

    recorder.stop();
  }

  async function beginPressToTalk(event) {
    event.preventDefault();
    if (event.currentTarget.setPointerCapture) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
    }

    activePointerIdRef.current = event.pointerId;
    await startRecording();
  }

  function endPressToTalk(event) {
    if (activePointerIdRef.current !== event.pointerId) return;
    activePointerIdRef.current = null;

    if (event.currentTarget.releasePointerCapture) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {}
    }

    finishRecording(true);
  }

  function cancelPressToTalk(event) {
    if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return;
    activePointerIdRef.current = null;
    finishRecording(false);
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const todayLabel = new Date().toLocaleDateString("uz-UZ", {
    weekday: "long",
    day: "numeric",
    month: "long"
  });
  const greetingTitle = getGreetingTitle();

  const sortedReminders = useMemo(() => {
    return [...reminders].sort((a, b) => new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime());
  }, [reminders]);

  const pendingTasks = useMemo(() => tasks.filter((task) => !task.completed), [tasks]);
  const completedTasks = useMemo(() => tasks.filter((task) => task.completed), [tasks]);
  const openReminders = useMemo(() => sortedReminders.filter((item) => !item.done), [sortedReminders]);
  const doneReminders = useMemo(() => sortedReminders.filter((item) => item.done), [sortedReminders]);
  const visibleTasks = taskFilter === "done" ? completedTasks : pendingTasks;
  const visibleReminders = reminderFilter === "done" ? doneReminders : openReminders;
  const expenseToday = useMemo(() => summarizeExpenses(expenses, "today"), [expenses]);
  const expenseWeek = useMemo(() => summarizeExpenses(expenses, "week"), [expenses]);
  const expenseMonth = useMemo(() => summarizeExpenses(expenses, "month"), [expenses]);
  const uzsSeries = useMemo(() => buildExpenseSeries(expenses, "UZS", 30), [expenses]);
  const usdSeries = useMemo(() => buildExpenseSeries(expenses, "USD", 30), [expenses]);
  const selectedVoiceLabel = getVoiceLabel(settings.ttsVoiceModel);
  const lastSpeechLabel =
    speechInfo.source === "uzbekvoice"
      ? `${getVoiceLabel(speechInfo.model)} ovozi faol.`
      : speechInfo.source === "browser"
        ? "Brauzer ovozi ishlagan."
        : speechInfo.source === "error"
          ? "Ovozda muammo bor."
          : "Sinov tugmasi orqali tekshiring.";

  return (
    <div className="app">
      <div className="top-bar">
        <div>
          <span className="eyebrow">{todayLabel}</span>
          <h1>Kotiba AI</h1>
          <p className="top-subtitle">Shaxsiy yordamchi</p>
        </div>
        <div className={`status pill ${status}`}>{statusLabels[status] || status}</div>
      </div>

      <div className="screen">
        {page === "home" && (
          <>
            <div className="card hero-card home-chat-shell">
              <div className="hero-head">
                <div>
                  <span className="eyebrow">Suhbat</span>
                  <h2>{greetingTitle}</h2>
                </div>
                <div className={`assistant-orb ${status}`} />
              </div>
              <div className="chat-thread">
                {transcript ? (
                  <div className="chat-bubble user">
                    <span className="chat-label">Siz</span>
                    <p>{transcript}</p>
                  </div>
                ) : (
                  <div className="chat-empty">Micni bosib gapiring yoki xabar yozing.</div>
                )}
                <div className="chat-bubble assistant">
                  <span className="chat-label">Kotiba</span>
                  <p>{reply}</p>
                </div>
              </div>
            </div>

            <div className="card compact-card composer-card">
              <div className="section-head">
                <h2>Xabar yuborish</h2>
              </div>
              <textarea
                className="text-input compact-input"
                rows="3"
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                placeholder="Masalan: bugun 6 da eslatma qo'sh"
              />
              <button className="button" onClick={submitTextPrompt} disabled={!draftText.trim()}>
                Yuborish
              </button>
            </div>

            {errorMessage && <div className="error">{errorMessage}</div>}
          </>
        )}

        {page === "tasks" && (
          <>
            <div className="card compact-card">
              <div className="section-head">
                <h2>Vazifalar</h2>
                <span className="section-meta">{pendingTasks.length} ta ochiq</span>
              </div>

              <div className="segmented">
                <button className={taskFilter === "open" ? "segment active" : "segment"} onClick={() => setTaskFilter("open")}>
                  Ochiq
                </button>
                <button className={taskFilter === "done" ? "segment active" : "segment"} onClick={() => setTaskFilter("done")}>
                  Bajarilgan
                </button>
              </div>

              <div className="inline-form">
                <input
                  className="text-input slim-input"
                  value={taskTitle}
                  onChange={(event) => setTaskTitle(event.target.value)}
                  placeholder="Yangi vazifa"
                />
                <button className="button button-inline" onClick={addTask} disabled={!taskTitle.trim()}>
                  Qo'shish
                </button>
              </div>
            </div>

            <div className="list-stack">
              {visibleTasks.map((task) => (
                <div key={task.id} className={`task-card ${task.completed ? "done" : ""}`}>
                  <div className="task-main">
                    <strong className="task-title">{task.title}</strong>
                    <div className="task-meta">
                      <span className={`status-badge ${task.completed ? "done" : "open"}`}>
                        {task.completed ? "Bajarilgan" : "Ochiq"}
                      </span>
                      <span>{formatShortDateTime(task.createdAt)}</span>
                    </div>
                  </div>
                  <button className="button task-action" onClick={() => completeTask(task.id)} disabled={task.completed}>
                    {task.completed ? "Tayyor" : "Bajarildi"}
                  </button>
                </div>
              ))}

              {visibleTasks.length === 0 && (
                <div className="card empty-card">
                  <strong>{taskFilter === "open" ? "Ochiq vazifa yo'q." : "Bajarilgan vazifa yo'q."}</strong>
                  <p>Yangi vazifa qo'shsangiz shu yerda ko'rinadi.</p>
                </div>
              )}
            </div>
          </>
        )}

        {page === "reminders" && (
          <>
            <div className="card compact-card">
              <div className="section-head">
                <h2>Eslatmalar</h2>
                <span className="section-meta">{openReminders.length} ta faol</span>
              </div>

              <div className="segmented">
                <button className={reminderFilter === "upcoming" ? "segment active" : "segment"} onClick={() => setReminderFilter("upcoming")}>
                  Faol
                </button>
                <button className={reminderFilter === "done" ? "segment active" : "segment"} onClick={() => setReminderFilter("done")}>
                  Bajarilgan
                </button>
              </div>

              <div className="stack-form">
                <input
                  className="text-input slim-input"
                  value={reminderTitle}
                  onChange={(event) => setReminderTitle(event.target.value)}
                  placeholder="Eslatma nomi"
                />
                <input
                  className="text-input slim-input"
                  type="datetime-local"
                  value={reminderTime}
                  onChange={(event) => setReminderTime(event.target.value)}
                />
                <button className="button" onClick={addReminder} disabled={!reminderTitle.trim() || !reminderTime}>
                  Eslatma qo'shish
                </button>
              </div>
            </div>

            <div className="list-stack">
              {visibleReminders.map((reminder) => (
                <div key={reminder.id} className={`reminder-card ${reminder.done ? "done" : ""}`}>
                  <div className="task-main">
                    <strong className="task-title">{reminder.title}</strong>
                    <div className="task-meta">
                      <span className={`status-badge ${reminder.done ? "done" : "open"}`}>
                        {reminder.done ? "Yopilgan" : "Faol"}
                      </span>
                      <span>{formatShortDateTime(reminder.time)}</span>
                      <span>{formatReminderRepeatLabel(reminder.repeat)}</span>
                    </div>
                  </div>
                  <div className="reminder-actions">
                    <button className="button reminder-action" onClick={() => toggleReminderDone(reminder)}>
                      {reminder.done ? "Qayta ochish" : "Bajarildi"}
                    </button>
                    <button className="button button-secondary reminder-action" onClick={() => deleteReminder(reminder.id)}>
                      O'chirish
                    </button>
                  </div>
                </div>
              ))}

              {visibleReminders.length === 0 && (
                <div className="card empty-card">
                  <strong>{reminderFilter === "upcoming" ? "Faol eslatma yo'q." : "Yopilgan eslatma yo'q."}</strong>
                  <p>Yangi eslatma shu sahifada qo'shiladi.</p>
                </div>
              )}
            </div>
          </>
        )}

        {page === "expenses" && (
          <>
            <div className="card compact-card">
              <div className="section-head">
                <h2>Xarajatlar</h2>
                <span className="section-meta">{expenses.length} ta yozuv</span>
              </div>

              <div className="metric-grid expense-grid">
                <div className="small-card metric-card">
                  <strong>Bugun</strong>
                  <p>{buildExpenseTotalsText(expenseToday.totals)}</p>
                </div>
                <div className="small-card metric-card">
                  <strong>Bu hafta</strong>
                  <p>{buildExpenseTotalsText(expenseWeek.totals)}</p>
                </div>
                <div className="small-card metric-card">
                  <strong>Bu oy</strong>
                  <p>{buildExpenseTotalsText(expenseMonth.totals)}</p>
                </div>
              </div>

              <div className="stack-form">
                <input
                  className="text-input slim-input"
                  value={expenseTitle}
                  onChange={(event) => setExpenseTitle(event.target.value)}
                  placeholder="Masalan: ovqat, yo'l, kofe"
                />
                <div className="inline-form">
                  <input
                    className="text-input slim-input"
                    inputMode="decimal"
                    value={expenseAmount}
                    onChange={(event) => setExpenseAmount(event.target.value)}
                    placeholder="Miqdor"
                  />
                  <select
                    className="select-input"
                    value={expenseCurrency}
                    onChange={(event) => setExpenseCurrency(event.target.value)}
                  >
                    <option value="UZS">So'm</option>
                    <option value="USD">Dollar</option>
                  </select>
                </div>
                <button className="button" onClick={addExpense} disabled={!expenseTitle.trim() || !expenseAmount.trim()}>
                  Xarajat qo'shish
                </button>
              </div>
            </div>

            <ExpenseChart title="So'm bo'yicha chiziq" currency="UZS" data={uzsSeries} stroke="#1268f3" />
            <ExpenseChart title="Dollar bo'yicha chiziq" currency="USD" data={usdSeries} stroke="#1f9d62" />

            <div className="card compact-card">
              <div className="section-head">
                <h2>Oxirgi yozuvlar</h2>
              </div>

              <div className="list-stack">
                {expenses.slice(0, 8).map((expense) => (
                  <div key={expense.id} className="task-card">
                    <div className="task-main">
                      <strong className="task-title">{expense.title}</strong>
                      <div className="task-meta">
                        <span className="status-badge open">{expense.currency === "USD" ? "Dollar" : "So'm"}</span>
                        <span>{formatShortDateTime(expense.occurredAt || expense.createdAt)}</span>
                      </div>
                    </div>
                    <div className="expense-row-actions">
                      <strong className="expense-amount">{formatExpenseAmount(expense.amount, expense.currency)}</strong>
                      <button className="button button-secondary task-action" onClick={() => deleteExpense(expense.id)}>
                        O'chirish
                      </button>
                    </div>
                  </div>
                ))}

                {expenses.length === 0 && (
                  <div className="card empty-card">
                    <strong>Hali xarajat yo'q.</strong>
                    <p>Masalan, “bugun 20 ming so'm ishlatdim” deb ayting.</p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {page === "settings" && (
          <>
            <div className="card compact-card">
              <div className="section-head">
                <h2>Ko'rinish va ovoz</h2>
              </div>

              <div className="setting-row">
                <div className="setting-copy">
                  <strong>Tungi ko'rinish</strong>
                  <span>Interfeys rangini almashtiradi.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.theme === "dark"}
                    onChange={(event) => updateSetting("theme", event.target.checked ? "dark" : "light")}
                  />
                  <span className="switch-slider" />
                </label>
              </div>

              <div className="setting-stack">
                <label htmlFor="voice-model">Kotiba ovozi</label>
                <select
                  id="voice-model"
                  className="select-input"
                  value={settings.ttsVoiceModel}
                  onChange={(event) => updateSetting("ttsVoiceModel", event.target.value)}
                >
                  {voiceModels.map((voice) => (
                    <option key={voice.value} value={voice.value}>
                      {voice.label}
                    </option>
                  ))}
                </select>
                <div className="voice-status-card">
                  <strong>{selectedVoiceLabel}</strong>
                  <span>{lastSpeechLabel}</span>
                </div>
                <button className="button" onClick={testSelectedVoice}>
                  Ovoz sinovi
                </button>
              </div>

              <div className="setting-row">
                <div className="setting-copy">
                  <strong>Ovoz bilan javob</strong>
                  <span>Javobni ovoz chiqarib o'qiydi.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.autoSpeakReplies}
                    onChange={(event) => updateSetting("autoSpeakReplies", event.target.checked)}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>

            <div className="card compact-card">
              <div className="section-head">
                <h2>Boshqaruv</h2>
              </div>

              <div className="setting-row">
                <div className="setting-copy">
                  <strong>Ovozli buyruqlar</strong>
                  <span>Navigatsiya va tezkor amallar uchun.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.voiceControlEnabled}
                    onChange={(event) => updateSetting("voiceControlEnabled", event.target.checked)}
                  />
                  <span className="switch-slider" />
                </label>
              </div>

              <div className="setting-row">
                <div className="setting-copy">
                  <strong>Vazifa eslatmasi</strong>
                  <span>Ochiq vazifalarni qayta eslatadi.</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.taskFollowUpEnabled}
                    onChange={(event) => updateSetting("taskFollowUpEnabled", event.target.checked)}
                  />
                  <span className="switch-slider" />
                </label>
              </div>

              <div className="setting-stack">
                <label htmlFor="followup-interval">Eslatish oralig'i</label>
                <select
                  id="followup-interval"
                  className="select-input"
                  value={settings.taskFollowUpMinutes}
                  onChange={(event) => updateSetting("taskFollowUpMinutes", Number(event.target.value))}
                >
                  <option value={10}>Har 10 minut</option>
                  <option value={20}>Har 20 minut</option>
                  <option value={30}>Har 30 minut</option>
                  <option value={60}>Har 1 soat</option>
                </select>
              </div>
            </div>

            <div className="card compact-card">
              <div className="section-head">
                <h2>Ruxsat va tizim</h2>
              </div>

              <div className="setting-row">
                <div className="setting-copy">
                  <strong>Mikrofon</strong>
                  <span>{formatPermissionLabel(microphoneStatus)}</span>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-copy">
                  <strong>Bildirishnoma</strong>
                  <span>{formatPermissionLabel(notificationStatus)}</span>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-copy">
                  <strong>Server</strong>
                  <span>{formatHealthLabel(health.status)}</span>
                </div>
              </div>

              <button className="button" onClick={requestNotifications} disabled={notificationStatus === "granted"}>
                {notificationStatus === "granted" ? "Bildirishnoma yoqilgan" : "Bildirishnomani yoqish"}
              </button>
              {notificationHelpText && <p className="helper-note">{notificationHelpText}</p>}
              <button className="button button-secondary" onClick={pingHealth}>
                Holatni tekshirish
              </button>
              <button className="button button-secondary" onClick={() => deleteAllReminders()}>
                Eslatmalarni tozalash
              </button>
            </div>

            <div className="card compact-card">
              <div className="section-head">
                <h2>Qisqa buyruqlar</h2>
              </div>
              <div className="command-list">
                <span>tungi rejimni yoq</span>
                <span>vazifalarni och</span>
                <span>eslatmalarni och</span>
                <span>lola ovoziga o't</span>
              </div>
              {speechInfo.source === "browser" && (
                <p className="helper-note voice-warning-note">Brauzer ovozi ishlagan, shu sabab kotiba ovozi almashmagandek eshitilishi mumkin.</p>
              )}
            </div>
          </>
        )}
      </div>

      {page === "home" && (
        <div className="voice-dock">
          <div className="voice-dock-card">
            <div className="voice-dock-copy">
              <strong>{status === "listening" ? "Tinglayapman" : "Mikrofon"}</strong>
              <span>{status === "listening" ? "Qo'lingizni olsangiz yuboriladi." : "Bosib gapiring."}</span>
            </div>
            <button
              className={`mic-btn dock-mic-btn ${status === "listening" ? "listening" : ""}`}
              onPointerDown={beginPressToTalk}
              onPointerUp={endPressToTalk}
              onPointerCancel={cancelPressToTalk}
              aria-label="Ovoz yozish"
              disabled={status === "thinking"}
            >
              🎙
            </button>
          </div>
        </div>
      )}

      <nav className="bottom-nav">
        <button className={page === "home" ? "active" : ""} onClick={() => setPage("home")}>
          Asosiy
        </button>
        <button className={page === "tasks" ? "active" : ""} onClick={() => setPage("tasks")}>
          Vazifalar
        </button>
        <button className={page === "reminders" ? "active" : ""} onClick={() => setPage("reminders")}>
          Eslatmalar
        </button>
        <button className={page === "expenses" ? "active" : ""} onClick={() => setPage("expenses")}>
          Xarajatlar
        </button>
        <button className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")}>
          Sozlamalar
        </button>
      </nav>
    </div>
  );
}

export default App;
