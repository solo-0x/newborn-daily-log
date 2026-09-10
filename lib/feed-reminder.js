const reminderStyles = `
<style>
.feed-reminder{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:14px;padding:17px 20px;border-color:#cfe0ff;background:linear-gradient(135deg,#f8fbff,#eef5ff)}
.reminder-copy{min-width:0}.reminder-label{font-size:13px;font-weight:850;color:#2d64d8}.reminder-status{font-size:20px;font-weight:850;margin-top:5px}.reminder-detail{font-size:11px;color:var(--muted);line-height:1.55;margin-top:4px}
.digital-clock{flex:0 0 auto;font-family:"SFMono-Regular","Roboto Mono","Cascadia Mono","Courier New",monospace;font-variant-numeric:tabular-nums;font-size:39px;line-height:1;font-weight:800;letter-spacing:3px;color:#255ac7;text-shadow:0 1px 0 #fff}
.feed-reminder.soon{border-color:#f0ca7c;background:linear-gradient(135deg,#fffdf7,#fff5dc)}.feed-reminder.soon .reminder-label,.feed-reminder.soon .digital-clock{color:#a96500}
.feed-reminder.overdue{border-color:#efb1b3;background:linear-gradient(135deg,#fffafa,#ffeded)}.feed-reminder.overdue .reminder-label,.feed-reminder.overdue .digital-clock{color:#bd363c}
.feed-reminder.empty-reminder{border-color:var(--line);background:#fff}.feed-reminder.empty-reminder .digital-clock{color:#9da7b5}
@media(max-width:760px){.feed-reminder{margin-bottom:10px;padding:15px 16px;gap:10px}.reminder-status{font-size:17px}.digital-clock{font-size:31px;letter-spacing:2px}.reminder-detail{max-width:230px}}
</style>`;

const reminderMarkup = `  <section id="feedReminder" class="card feed-reminder empty-reminder" aria-live="polite">
    <div class="reminder-copy"><div class="reminder-label">🍼 下次喂奶</div><div id="reminderStatus" class="reminder-status">等待喂奶记录</div><div id="reminderDetail" class="reminder-detail">记录一次喂奶后自动计算 · 默认间隔 2 小时</div></div>
    <div id="nextFeedClock" class="digital-clock">--:--</div>
  </section>
`;

const intervalSetting = `          <div class="field"><label class="label" for="settingFeedInterval">下次喂奶提醒间隔</label><select id="settingFeedInterval" class="select-input"><option value="60">1 小时</option><option value="90">1.5 小时</option><option value="120">2 小时（默认）</option><option value="150">2.5 小时</option><option value="180">3 小时</option><option value="210">3.5 小时</option><option value="240">4 小时</option></select><div class="hint">按最近一次喂奶记录自动计算，设置对全部家庭成员生效。</div></div>
`;

function installFeedReminder() {
  function intervalLabel(minutes) {
    const hours = minutes / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
  }

  function compactDuration(minutes) {
    const total = Math.max(0, Math.round(minutes));
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    if (hours && rest) return `${hours} 小时 ${rest} 分钟`;
    return hours ? `${hours} 小时` : `${rest} 分钟`;
  }

  function zonedDateTimeMs(date, time) {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const target = Date.UTC(year, month - 1, day, hour, minute);
    let guess = target;
    for (let i = 0; i < 2; i++) {
      const parts = zonedParts(new Date(guess));
      const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
      guess -= shown - target;
    }
    return guess;
  }

  function shortRecordTime(record) {
    if (!record) return '';
    if (record.date === dateStr()) return record.time;
    return `${Number(record.date.slice(5, 7))}月${Number(record.date.slice(8, 10))}日 ${record.time}`;
  }

  window.renderFeedReminder = function renderFeedReminder() {
    const box = $('#feedReminder');
    const clock = $('#nextFeedClock');
    const status = $('#reminderStatus');
    const detail = $('#reminderDetail');
    if (!box) return;
    box.classList.remove('empty-reminder', 'soon', 'overdue');
    const record = state.latest.feed;
    const minutes = state.settings.feedIntervalMinutes || 120;
    if (!record) {
      box.classList.add('empty-reminder');
      clock.textContent = '--:--';
      status.textContent = '等待喂奶记录';
      detail.textContent = `记录一次喂奶后自动计算 · 当前间隔 ${intervalLabel(minutes)}`;
      return;
    }
    const base = zonedDateTimeMs(record.date, record.time);
    if (!Number.isFinite(base)) {
      box.classList.add('empty-reminder');
      clock.textContent = '--:--';
      status.textContent = '时间暂不可用';
      detail.textContent = '请检查最近一次喂奶记录的日期与时间';
      return;
    }
    const next = new Date(base + minutes * 60000);
    const diffMinutes = (next.getTime() - Date.now()) / 60000;
    const parts = zonedParts(next);
    clock.textContent = `${parts.hour}:${parts.minute}`;
    if (diffMinutes < 0) {
      box.classList.add('overdue');
      status.textContent = `已超过 ${compactDuration(Math.abs(diffMinutes))}`;
    } else {
      if (diffMinutes <= 30) box.classList.add('soon');
      status.textContent = `还有 ${compactDuration(diffMinutes)}`;
    }
    const targetDate = `${parts.year}-${parts.month}-${parts.day}`;
    const tomorrow = dateStr(new Date(Date.now() + 86400000));
    const dayLabel = targetDate === dateStr() ? '今天' : targetDate === tomorrow ? '明天' : `${Number(parts.month)}月${Number(parts.day)}日`;
    detail.textContent = `${dayLabel} · 上次 ${shortRecordTime(record)} · 间隔 ${intervalLabel(minutes)}`;
  };

  setInterval(() => {
    if (state.user) window.renderFeedReminder();
  }, 30000);
}

function replaceOnce(html, search, replacement, label) {
  if (!html.includes(search)) throw new Error(`无法合并喂奶提醒：缺少${label}`);
  return html.replace(search, replacement);
}

export function enhanceWithFeedReminder(baseHtml) {
  let html = replaceOnce(baseHtml, '</head>', `${reminderStyles}\n</head>`, '样式插入点');
  html = replaceOnce(html, '  <section class="hero">', `${reminderMarkup}  <section class="hero">`, '首页插入点');
  html = replaceOnce(html, '        <section class="settings-section"><div class="settings-section-title">记录设置</div>\n', `        <section class="settings-section"><div class="settings-section-title">记录设置</div>\n${intervalSetting}`, '设置插入点');
  html = replaceOnce(html, 'customFormulaMin:60,customFormulaMax:90};', 'customFormulaMin:60,customFormulaMax:90,feedIntervalMinutes:120};', '默认设置');
  html = replaceOnce(html, 'state.openSwipe=null;bindSwipeRows()}', 'state.openSwipe=null;bindSwipeRows();window.renderFeedReminder?.()}', '页面刷新逻辑');
  html = replaceOnce(html, "$('#settingFormulaMax').value=state.settings.customFormulaMax;toggleCustomReference();", "$('#settingFormulaMax').value=state.settings.customFormulaMax;$('#settingFeedInterval').value=String(state.settings.feedIntervalMinutes);toggleCustomReference();", '设置回显逻辑');
  html = replaceOnce(html, "customFormulaMax:Number($('#settingFormulaMax').value)", "customFormulaMax:Number($('#settingFormulaMax').value),feedIntervalMinutes:Number($('#settingFeedInterval').value)", '设置保存逻辑');
  html = replaceOnce(html, 'bootstrap();\n\n</script>', `(${installFeedReminder.toString()})();bootstrap();\n\n</script>`, '提醒脚本插入点');
  return html;
}
