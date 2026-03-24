// @ts-ignore - vscode webview API
const vscode = acquireVsCodeApi();

const agentPickerView = document.getElementById('agent-picker-view')!;
const chatView = document.getElementById('chat-view')!;
const messagesEl = document.getElementById('messages')!;
const msgInput = document.getElementById('msg-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn')!;
const pickAgentBtn = document.getElementById('pick-agent-btn')!;
const codeContextEl = document.getElementById('code-context')!;
const ctxLabel = document.getElementById('ctx-label')!;
const ctxClear = document.getElementById('ctx-clear')!;
const fileContextEl = document.getElementById('file-context')!;
const fileCtxLabel = document.getElementById('file-ctx-label')!;

function showView(view: 'agentPicker' | 'chat') {
  agentPickerView.classList.remove('active');
  chatView.classList.remove('active');
  if (view === 'agentPicker') agentPickerView.classList.add('active');
  else chatView.classList.add('active');
}

function renderMessage(msg: any) {
  const div = document.createElement('div');
  div.className = `msg ${msg.sender_type}`;
  const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `
    <div class="sender">${escapeHtml(msg.sender_name)}</div>
    <div class="content">${escapeHtml(msg.content)}</div>
    <div class="time">${time}</div>
  `;
  return div;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

pickAgentBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'selectAgent' });
});

sendBtn.addEventListener('click', () => {
  const text = msgInput.value.trim();
  if (text) {
    vscode.postMessage({ type: 'send', text });
    msgInput.value = '';
    msgInput.style.height = 'auto';
  }
});

msgInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

msgInput.addEventListener('input', () => {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
});

ctxClear.addEventListener('click', () => {
  codeContextEl.classList.remove('visible');
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'showAgentPicker':
      showView('agentPicker');
      break;
    case 'init': {
      showView('chat');
      messagesEl.innerHTML = '';
      const messages = msg.messages || [];
      messages.reverse().forEach((m: any) => {
        messagesEl.appendChild(renderMessage(m));
      });
      scrollToBottom();
      break;
    }
    case 'message': {
      messagesEl.appendChild(renderMessage(msg.message));
      scrollToBottom();
      break;
    }
    case 'fileContext': {
      if (msg.context) {
        fileCtxLabel.textContent = `${msg.context.relativePath}:${msg.context.cursorLine} (${msg.context.languageId})`;
        fileContextEl.classList.add('visible');
      } else {
        fileContextEl.classList.remove('visible');
      }
      break;
    }
    case 'codeContext': {
      if (msg.context) {
        ctxLabel.textContent = `${msg.context.relativePath}:${msg.context.startLine}-${msg.context.endLine} (${msg.context.languageId})`;
        codeContextEl.classList.add('visible');
      } else {
        codeContextEl.classList.remove('visible');
      }
      break;
    }
  }
});

vscode.postMessage({ type: 'ready' });
