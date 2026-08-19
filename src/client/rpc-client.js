// 由宿主层注入到 JxPan 前端页面，加「推送到 Aria2」按钮和 RPC 配置面板。
// 不解析页面 DOM 结构，而是包装 worker 前端已有的顶层函数并读它的全局变量 ——
// 上游改版式时这样最不容易碎。
(function () {
  'use strict';

  var API = '/_host/rpc/';
  var HOST = window.__JXPAN_HOST__ || {};
  var BTN_STYLE =
    'display:inline-flex;align-items:center;gap:4px;padding:6px 12px;margin:4px 4px 0 0;' +
    'border:1px solid #0ea5e9;border-radius:6px;background:#0ea5e9;color:#fff;' +
    'font-size:13px;cursor:pointer;font-family:inherit;';

  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json();
    });
  }

  function toast(message, ok) {
    var el = document.createElement('div');
    el.textContent = message;
    el.style.cssText =
      'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);z-index:99999;' +
      'padding:10px 18px;border-radius:8px;font-size:14px;max-width:80vw;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.18);color:#fff;background:' +
      (ok ? '#10b981' : '#ef4444');
    document.body.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 4200);
  }

  // ---------- 配置面板 ----------

  var overlay;

  function field(label, id, type, hint) {
    return (
      '<label style="display:block;margin-bottom:12px">' +
      '<div style="font-size:13px;color:#374151;margin-bottom:4px">' + label + '</div>' +
      '<input id="' + id + '" type="' + (type || 'text') + '" style="width:100%;padding:7px 10px;' +
      'border:1px solid #d1d5db;border-radius:6px;font-size:13px;box-sizing:border-box">' +
      (hint ? '<div style="font-size:11px;color:#9ca3af;margin-top:4px">' + hint + '</div>' : '') +
      '</label>'
    );
  }

  function buildPanel() {
    overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.45);display:none;' +
      'align-items:center;justify-content:center;';
    overlay.innerHTML =
      '<div style="background:#fff;border-radius:12px;padding:22px;width:min(440px,92vw);' +
      'font-family:system-ui,sans-serif;max-height:90vh;overflow:auto">' +
      '<div style="font-size:16px;font-weight:600;margin-bottom:16px">Aria2 RPC 设置</div>' +
      field('RPC 地址', 'jxRpcUrl', 'text',
        '必须带端口：aria2c 默认 6800，Motrix 默认 16800。' +
        '例如 http://192.168.1.10:6800/jsonrpc') +
      field('RPC 密钥', 'jxRpcToken', 'password', '无密钥留空。留空提交表示不修改已保存的密钥') +
      field('保存目录', 'jxRpcDir', 'text', 'aria2 那一侧的路径，例如 /downloads 或 D:\\Downloads') +
      '<label style="display:block;margin-bottom:12px">' +
      '<div style="font-size:13px;color:#374151;margin-bottom:4px">推送方式</div>' +
      '<select id="jxRpcMode" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;' +
      'border-radius:6px;font-size:13px;box-sizing:border-box">' +
      '<option value="auto">自动（推荐）—— 能直推就直推</option>' +
      '<option value="direct">强制直链 —— 不经过 JxPan</option>' +
      '<option value="jxpan">强制 JxPan 链接 —— 兼容性最好</option>' +
      '</select>' +
      '<div style="font-size:11px;color:#9ca3af;margin-top:4px">' +
      '自动：UC / 天翼 / 123 / 蓝奏优享直推裸直链；夸克 / 光鸭直推直链并自动补上 ' +
      'Cookie、Referer、专用 UA；阿里云盘的请求头无法从混淆代码里复刻，只能退回 JxPan 链接。' +
      '</div></label>' +
      field('JxPan 对外地址（可选）', 'jxRpcBase', 'text',
        '留空即可，默认用你当前浏览器地址。只有退回 JxPan 链接时才会用到 —— ' +
        '此时 aria2 要用它回连 JxPan，所以 aria2 在别的容器/机器上时不能是 127.0.0.1。') +
      '<div style="display:flex;gap:8px;margin-top:4px">' +
      '<button id="jxRpcSave" style="' + BTN_STYLE + 'flex:1;justify-content:center">保存</button>' +
      '<button id="jxRpcTest" style="' + BTN_STYLE +
      'flex:1;justify-content:center;background:#fff;color:#0ea5e9">测试连接</button>' +
      '<button id="jxRpcClose" style="' + BTN_STYLE +
      'background:#fff;color:#6b7280;border-color:#d1d5db">关闭</button>' +
      '</div></div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) hidePanel();
    });
    overlay.querySelector('#jxRpcClose').addEventListener('click', hidePanel);

    overlay.querySelector('#jxRpcSave').addEventListener('click', function () {
      var token = overlay.querySelector('#jxRpcToken').value;
      post('config', {
        rpc_url: overlay.querySelector('#jxRpcUrl').value.trim(),
        rpc_token: token === '__SET__' ? '' : token,
        rpc_dir: overlay.querySelector('#jxRpcDir').value.trim(),
        push_mode: overlay.querySelector('#jxRpcMode').value,
        public_base_url: overlay.querySelector('#jxRpcBase').value.trim(),
      }).then(function (r) {
        if (!r.success) {
          toast('保存失败: ' + r.msg, false);
          return;
        }
        if (r.warning) {
          // 端口填错是这里最常见的错误，别让它静默通过
          toast('已保存，但请注意：' + r.warning, false);
          return;
        }
        toast('配置已保存', true);
        hidePanel();
      });
    });

    overlay.querySelector('#jxRpcTest').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = '测试中...';
      post('test', {}).then(function (r) {
        btn.disabled = false;
        btn.textContent = '测试连接';
        toast(r.success ? '连接成功: ' + r.msg : '连接失败: ' + r.msg, r.success);
      });
    });
  }

  function hidePanel() {
    overlay.style.display = 'none';
  }

  function showPanel() {
    if (!overlay) buildPanel();
    fetch(API + 'config')
      .then(function (r) {
        return r.json();
      })
      .then(function (r) {
        var c = (r.data && r.data.config) || {};
        overlay.querySelector('#jxRpcUrl').value = c.rpc_url || '';
        overlay.querySelector('#jxRpcToken').value = c.rpc_token === '__SET__' ? '__SET__' : '';
        overlay.querySelector('#jxRpcDir').value = c.rpc_dir || '';
        overlay.querySelector('#jxRpcMode').value = c.push_mode || 'auto';
        overlay.querySelector('#jxRpcBase').value = c.public_base_url || '';
        overlay.style.display = 'flex';
      });
  }

  // ---------- 推送 ----------

  function doPush(payload, button) {
    var original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '推送中...';
    post('push', payload)
      .then(function (r) {
        button.disabled = false;
        button.innerHTML = original;
        if (r.needAuth) {
          toast('需要先登录后台 /admin 才能推送', false);
          return;
        }
        if (r.needConfig) {
          toast('还没配置 Aria2 RPC 地址', false);
          showPanel();
          return;
        }
        if (!r.success) {
          toast('推送失败: ' + r.msg, false);
          return;
        }
        var results = r.data.results || [];
        var failed = results.filter(function (x) {
          return !x.ok;
        });
        if (failed.length > 0) {
          toast(r.msg + '，失败原因: ' + failed[0].error, false);
          return;
        }
        // 说清这次是直推还是绕了 JxPan，绕了就把原因带上，省得对着任务失败猜
        var viaJxpan = results.filter(function (x) {
          return x.via === 'jxpan';
        });
        var note = viaJxpan.length > 0 ? '（经 JxPan 代理：' + (viaJxpan[0].reason || '') + '）' : '（直链）';
        toast('已推送到 Aria2 ' + r.msg + ' ' + note, true);
      })
      .catch(function (e) {
        button.disabled = false;
        button.innerHTML = original;
        toast('推送出错: ' + e.message, false);
      });
  }

  // 直接推 RPC 就够了，短链只是噪音。只摘按钮，后端 /api/create-short 和 /s/
  // 路由不动，已经生成过的旧短链继续有效。HIDE_SHORT_LINK=false 可恢复显示。
  function removeShortLinkButtons(container) {
    if (!HOST.hideShortLink || !container) return;
    var buttons = container.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.dataset.jxRpc) continue;
      var onclick = btn.getAttribute('onclick') || '';
      var isShortLink =
        btn.id === 'modalShortBtn' ||
        onclick.indexOf('generateShortLink') !== -1 ||
        onclick.indexOf('ShortLink') !== -1 ||
        btn.textContent.indexOf('短链') !== -1;
      if (isShortLink) btn.remove();
    }
  }

  function makeButton(label) {
    var btn = document.createElement('button');
    btn.style.cssText = BTN_STYLE;
    btn.innerHTML = '<span>⬇</span>' + label;
    btn.dataset.jxRpc = '1';
    return btn;
  }

  // 单文件解析弹窗：包装 updateParseDialog 拿到现成的 paramUrl（形如
  // /?url=...&pwd=...&id=...&type=down），比自己拼参数可靠
  function hookModal() {
    var original = window.updateParseDialog;
    if (typeof original !== 'function') return false;
    window.updateParseDialog = function (options) {
      var result = original.apply(this, arguments);
      try {
        var actions = document.getElementById('modalActions');
        removeShortLinkButtons(actions);
        if (actions && !actions.querySelector('[data-jx-rpc]') && options && options.paramUrl) {
          var btn = makeButton('推送到 Aria2');
          btn.addEventListener('click', function () {
            doPush({ paramUrl: options.paramUrl, out: options.fileName }, btn);
          });
          actions.appendChild(btn);
        }
      } catch (e) {
        console.warn('[jxpan-rpc] 弹窗按钮注入失败', e);
      }
      return result;
    };
    return true;
  }

  // 主结果区（单文件 / 多文件）：读 currentParseResult 和输入框
  function hookResult() {
    var original = window.displayResult;
    if (typeof original !== 'function') return false;
    window.displayResult = function (result) {
      var out = original.apply(this, arguments);
      try {
        var box = document.getElementById('result');
        removeShortLinkButtons(box);
        var data = result && result.data;
        var pushable = result && result.success && data && (data.download_url || data.files);
        if (box && pushable && !box.querySelector('[data-jx-rpc]')) {
          var label = data.files ? '全部推送到 Aria2（' + data.file_count + '）' : '推送到 Aria2';
          var btn = makeButton(label);
          btn.style.width = '100%';
          btn.style.justifyContent = 'center';
          btn.addEventListener('click', function () {
            var shareInput = document.getElementById('shareUrl');
            var pwdInput = document.getElementById('sharePassword');
            doPush(
              {
                shareUrl: shareInput ? shareInput.value.trim() : window.currentShareUrl,
                pwd: pwdInput ? pwdInput.value.trim() : window.currentFolderPwd,
                id: (document.getElementById('selectedFileId') || {}).value || '',
              },
              btn
            );
          });
          box.appendChild(btn);
        }
      } catch (e) {
        console.warn('[jxpan-rpc] 结果区按钮注入失败', e);
      }
      return out;
    };
    return true;
  }

  // ---------- 把数据库里已有的凭据回填到「网盘配置」输入框 ----------
  // worker 的前端只在本次会话扫码后才填这些框（window.memoryConfig 是纯内存的），
  // 已经落在 D1 里的凭据看不见，页面显示成「没配」很误导。
  // 凭据取自 /?action=login_status；未登录 /admin 时该接口已被 guard 脱敏，
  // 这时只提示「库里有，登录后可见」，不会泄露内容。
  var CRED_FIELDS = [
    { platform: 'aliyun', id: 'aliyunAuth', pick: function (i) { return i.authorization || i.access_token; } },
    { platform: 'quark', id: 'quarkCookie', pick: function (i) { return i.cookie; } },
    { platform: 'uc', id: 'ucCookie', pick: function (i) { return i.cookie; } },
    { platform: 'cloud189', id: 'c189Token', pick: function (i) { return i.open_access_token || i.access_token || i.app_access_token; } },
    { platform: 'pan123', id: 'pan123Token', pick: function (i) { return i.authorization || i.token; } },
    { platform: 'guangya', id: 'guangyaLogin', pick: function (i) { return JSON.stringify(i); } },
    { platform: 'mcloud', id: 'mcloudAuth', pick: function (i) { return i.authorization; } },
    { platform: 'mcloud', id: 'mcloudCookie', pick: function (i) { return i.cookie; } },
    { platform: 'ilanzou', id: 'ilanzouAccount', pick: function (i) { return i.account || i.username; } },
    { platform: 'ilanzou', id: 'ilanzouPassword', pick: function (i) { return i.password; } },
    { platform: 'feiji', id: 'feijipanAccount', pick: function (i) { return i.account || i.username; } },
    { platform: 'feiji', id: 'feijipanPassword', pick: function (i) { return i.password; } },
  ];

  function addNote(input, text, color, linkAdmin) {
    var host = input.parentNode;
    if (!host || host.querySelector('[data-jx-note]')) return;
    var note = document.createElement('div');
    note.dataset.jxNote = '1';
    note.style.cssText = 'font-size:11px;margin-top:3px;color:' + color;
    if (linkAdmin) {
      // 点一下直接去登录，不用自己猜要干什么
      note.innerHTML =
        '数据库里已有凭据 —— <a href="/admin" target="_blank" style="color:#0ea5e9;' +
        'text-decoration:underline">登录后台</a> 后刷新本页即可显示';
    } else {
      note.textContent = text;
    }
    host.appendChild(note);
  }

  function prefillCredentials() {
    if (HOST.prefillCredentials === false) return Promise.resolve();
    return fetch('/?action=login_status')
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        var all = (payload && payload.data) || {};
        for (var i = 0; i < CRED_FIELDS.length; i++) {
          var field = CRED_FIELDS[i];
          var input = document.getElementById(field.id);
          var info = all[field.platform];
          if (!input || !info || !info.logged_in) continue;

          if (!info.loginInfo) {
            addNote(input, null, '#9ca3af', true);
            continue;
          }
          var value = '';
          try { value = field.pick(info.loginInfo) || ''; } catch (e) { value = ''; }
          if (!value) continue;
          // 不覆盖用户已经手填的内容
          if (input.value && String(input.value).trim()) continue;
          input.value = value;
          addNote(input, '已从数据库载入（来源：' + (info.source || '未知') + '）', '#10b981');
        }
      })
      .catch(function (e) {
        console.warn('[jxpan-rpc] 回填凭据失败', e);
      });
  }

  // ---------- 入口 ----------

  function gearButton() {
    var gear = document.createElement('button');
    gear.textContent = '⚙ Aria2';
    gear.title = 'Aria2 RPC 设置';
    gear.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:99997;padding:8px 14px;' +
      'border:none;border-radius:20px;background:#0ea5e9;color:#fff;font-size:13px;' +
      'cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.2);font-family:system-ui,sans-serif';
    gear.addEventListener('click', showPanel);
    document.body.appendChild(gear);
  }

  function init() {
    gearButton();
    prefillCredentials();
    var modal = hookModal();
    var main = hookResult();
    if (!modal && !main) {
      console.warn('[jxpan-rpc] 未找到前端的 updateParseDialog / displayResult，推送按钮不会出现');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
