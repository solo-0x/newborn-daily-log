const uxStyles = `
<style>
.remember-row{display:flex;align-items:center;gap:9px;margin:1px 0 14px;color:#4b5565;font-size:13px;cursor:pointer;user-select:none}
.remember-row input{width:18px!important;height:18px;margin:0!important;accent-color:var(--primary)}
.main-refresh{width:38px;height:38px;display:grid;place-items:center;padding:0;font-size:19px;font-weight:700}
.main-refresh:disabled{opacity:.62;cursor:default}.main-refresh.refreshing .refresh-icon{display:inline-block;animation:refresh-spin .8s linear infinite}
.record-cancel{min-width:72px}.sheet-actions .btn.primary{min-width:110px}
@keyframes refresh-spin{to{transform:rotate(360deg)}}
@media(max-width:760px){.main-refresh{width:36px;height:36px}.sheet-actions .btn{padding-left:12px;padding-right:12px}}
</style>`;

const rememberLogin = `      <label class="remember-row"><input id="rememberLogin" type="checkbox" checked><span>记住登录（30 天）</span></label>
`;

const cancelRecordButton = '<button id="cancelRecordBtn" class="btn record-cancel" type="button">取消</button>';

// Keep this as source text instead of Function#toString(). Production bundlers may
// rename or anonymize function declarations, which would make the injected script invalid.
const recordCloseHelpers = `let recordBaseline='';
function recordDraftSnapshot(){return JSON.stringify({date:$('#recordDate').value,time:$('#recordTime').value,type:state.type,note:$('#note').value,otherTitle:$('#otherTitle').value,feedMode:value('#feedModeSeg'),amount:$('#feedAmount').value,duration:$('#nurseDuration').value,eliminationKind:value('#eliminationKindSeg'),urineStatus:value('#urineStatusSeg'),stoolColor:value('#stoolColorSeg'),stoolForm:value('#stoolFormSeg'),abnormalType:value('#abnormalTypeSeg'),severity:value('#severitySeg')})}
function attemptCloseModal(){if(recordBaseline&&recordDraftSnapshot()!==recordBaseline&&!confirm('已修改记录内容，确定放弃本次修改吗？'))return;closeModal()}
`;

function replaceOnce(html, search, replacement, label) {
  if (!html.includes(search)) throw new Error(`无法合并交互优化：缺少${label}`);
  return html.replace(search, replacement);
}

export function enhanceUserExperience(baseHtml) {
  let html = replaceOnce(baseHtml, '</head>', `${uxStyles}\n</head>`, '样式插入点');
  html = replaceOnce(html, 'placeholder="用户名" value="admin" maxlength="32"', 'placeholder="请输入用户名" maxlength="32"', '用户名输入框');
  html = replaceOnce(html, '      <input id="loginPass" type="password" autocomplete="current-password" placeholder="密码" maxlength="128">\n', '      <input id="loginPass" type="password" autocomplete="current-password" placeholder="密码" maxlength="128">\n' + rememberLogin, '记住登录插入点');
  html = replaceOnce(html, '<div class="toolbar"><span id="serverState" class="server-state">连接中…</span><span id="userBadge"', '<div class="toolbar"><span id="serverState" class="server-state">连接中…</span><button id="mainRefreshBtn" class="icon-btn main-refresh" type="button" aria-label="刷新数据" title="刷新数据"><span class="refresh-icon">↻</span></button><span id="userBadge"', '主页面工具栏');
  html = replaceOnce(html, '  <button id="refreshBtn">↻ 刷新服务器数据</button>\n', '', '菜单刷新入口');
  html = replaceOnce(html, '<div class="sheet-actions"><button id="deleteBtn" class="btn danger hidden">删除</button><button id="saveBtn"', `<div class="sheet-actions"><button id="deleteBtn" class="btn danger hidden">删除</button>${cancelRecordButton}<button id="saveBtn"`, '记录底部操作区');
  html = replaceOnce(html, "JSON.stringify({username:$('#loginUser').value.trim(),password:$('#loginPass').value})", "JSON.stringify({username:$('#loginUser').value.trim(),password:$('#loginPass').value,remember:$('#rememberLogin').checked})", '登录请求');
  html = replaceOnce(html, "applyUser(data.user);$('#loginPass').value='';", "applyUser(data.user);$('#loginUser').value='';$('#loginPass').value='';", '登录后清理');
  html = replaceOnce(html, 'function openModal(raw=null){', `${recordCloseHelpers}function openModal(raw=null){`, '记录关闭保护');
  html = replaceOnce(html, "closeAllSwipes();$('#recordModal').classList.remove('hidden')}", "closeAllSwipes();$('#recordModal').classList.remove('hidden');recordBaseline=recordDraftSnapshot()}", '记录初始状态');
  html = replaceOnce(html, "function closeModal(){$('#recordModal').classList.add('hidden');state.editingId=null}", "function closeModal(){$('#recordModal').classList.add('hidden');state.editingId=null;recordBaseline=''}", '记录关闭逻辑');
  html = replaceOnce(html, "async function refresh(){try{state.loadedDate=null;await loadLatestRecords();await loadRecords(state.date,true);render();toast('已刷新服务器数据')}catch(e){toast(e.message)}}", "async function refresh(){const btn=$('#mainRefreshBtn');if(btn.disabled)return;btn.disabled=true;btn.classList.add('refreshing');$('#serverState').textContent='同步中…';try{state.loadedDate=null;const settingsData=await api('/api/settings');applySettings(settingsData.settings);await Promise.all([loadLatestRecords(),loadRecords(state.date,true)]);render();$('#serverState').textContent='云端已连接';$('#serverState').className='server-state ok';toast('数据已刷新')}catch(e){$('#serverState').textContent='刷新失败';$('#serverState').className='server-state warn';toast(e.message)}finally{btn.disabled=false;btn.classList.remove('refreshing')}}", '刷新逻辑');
  html = replaceOnce(html, "$('#closeModal').addEventListener('click',closeModal);$('#recordModal').addEventListener('click',closeModal);$('#saveBtn')", "$('#closeModal').addEventListener('click',attemptCloseModal);$('#cancelRecordBtn').addEventListener('click',attemptCloseModal);$('#saveBtn')", '记录关闭事件');
  html = replaceOnce(html, "$('#refreshBtn').addEventListener('click',refresh);", "$('#mainRefreshBtn').addEventListener('click',refresh);", '主页面刷新事件');
  return html;
}
