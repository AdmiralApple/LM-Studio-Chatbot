const STORAGE_KEY = "lm_tts_chats_v1";
const TEMP_KEY = "lm_tts_temperature";
const VOICE_KEY = "lm_tts_voice";
const MODEL_KEY = "lm_tts_selected_model";
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant who responds concisely and clearly. Keep answers friendly and readable.";

const elements = {
  chatList: document.getElementById("chat-list"),
  newChatBtn: document.getElementById("new-chat-btn"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  promptInput: document.getElementById("prompt-input"),
  pendingIndicator: document.getElementById("pending-indicator"),
  redoBtn: document.getElementById("redo-btn"),
  stopAudioBtn: document.getElementById("stop-audio-btn"),
  status: document.getElementById("status"),
  temperatureInput: document.getElementById("temperature-input"),
  modelSelect: document.getElementById("model-select"),
  voiceSelect: document.getElementById("voice-select"),
};

const state = {
  chats: [],
  activeChatId: null,
  pending: false,
  temperature: 0.7,
  status: "",
  models: [],
  model: null,
  voices: [],
  voice: null,
  audioPlaying: false,
  editingMessageId: null,
  editingValue: "",
};

let audioPlayer = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  loadState();
  bindEvents();

  if (!state.chats.length) {
    const chat = createChat();
    state.chats.push(chat);
    state.activeChatId = chat.id;
  } else if (!state.activeChatId && state.chats[0]) {
    state.activeChatId = state.chats[0].id;
  }

  elements.temperatureInput.value = state.temperature.toFixed(1);
  render();

  await refreshModels();
  await refreshVoices();
}

function bindEvents() {
  elements.newChatBtn.addEventListener("click", () => {
    const chat = createChat();
    state.chats.unshift(chat);
    state.activeChatId = chat.id;
    saveState();
    render();
    elements.promptInput.focus();
  });

  elements.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = elements.promptInput.value.trim();
    if (!text || state.pending) return;
    const chat = getActiveChat();
    if (!chat) return;

    const message = {
      id: newId(),
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    chat.messages.push(message);
    updateChatTitle(chat);
    elements.promptInput.value = "";
    saveState();
    renderMessages();
    await requestAssistantResponse(chat);
  });

  elements.redoBtn.addEventListener("click", async () => {
    if (state.pending) return;
    const chat = getActiveChat();
    if (!chat || !chat.messages.length) return;
    const last = chat.messages[chat.messages.length - 1];
    if (last.role !== "assistant") return;
    chat.messages.pop();
    saveState();
    renderMessages();
    await requestAssistantResponse(chat);
  });

  elements.temperatureInput.addEventListener("change", () => {
    const value = clamp(parseFloat(elements.temperatureInput.value) || 0.7, 0, 1);
    state.temperature = value;
    elements.temperatureInput.value = value.toFixed(1);
    localStorage.setItem(TEMP_KEY, String(value));
  });

  elements.modelSelect.addEventListener("change", () => {
    const selection = elements.modelSelect.value;
    state.model = selection || null;
    if (selection) {
      localStorage.setItem(MODEL_KEY, selection);
    } else {
      localStorage.removeItem(MODEL_KEY);
    }
    updateControls();
  });

  elements.voiceSelect.addEventListener("change", () => {
    const selection = elements.voiceSelect.value;
    state.voice = selection || null;
    if (selection) {
      localStorage.setItem(VOICE_KEY, selection);
    } else {
      localStorage.removeItem(VOICE_KEY);
    }
    updateControls();
  });

  if (elements.stopAudioBtn) {
    elements.stopAudioBtn.addEventListener("click", () => {
      if (!state.audioPlaying) return;
      stopAudio(true);
    });
  }

  elements.promptInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    elements.composer.requestSubmit();
  });
}

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.chats = stored.chats ?? [];
    state.activeChatId = stored.activeChatId ?? null;
  } catch (error) {
    console.warn("Failed to load chats", error);
    state.chats = [];
  }

  const savedTemp = parseFloat(localStorage.getItem(TEMP_KEY) || "0.7");
  state.temperature = clamp(isNaN(savedTemp) ? 0.7 : savedTemp, 0, 1);
  state.model = localStorage.getItem(MODEL_KEY);
  state.voice = localStorage.getItem(VOICE_KEY);
}

function saveState() {
  const payload = {
    chats: state.chats.map((chat) => ({
      ...chat,
      messages: chat.messages.map(({ audioUrl, ...rest }) => rest),
    })),
    activeChatId: state.activeChatId,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function createChat() {
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: "New chat",
    createdAt: now,
    messages: [
      {
        id: newId(),
        role: "system",
        content: DEFAULT_SYSTEM_PROMPT,
        createdAt: now,
      },
    ],
  };
}

function getActiveChat() {
  return state.chats.find((chat) => chat.id === state.activeChatId) || null;
}

function updateChatTitle(chat) {
  const firstUser = chat.messages.find((m) => m.role === "user");
  if (firstUser) {
    chat.title =
      firstUser.content.length > 30
        ? `${firstUser.content.slice(0, 30)}…`
        : firstUser.content || "Untitled chat";
  }
}

function render() {
  renderChatList();
  renderMessages();
  renderModelSelect();
  renderVoiceSelect();
  updateStatus();
  updateControls();
}

function renderChatList() {
  elements.chatList.innerHTML = "";
  if (!state.chats.length) return;

  state.chats.forEach((chat) => {
    const btn = document.createElement("button");
    btn.className = "chat-list__item btn ghost";
    if (chat.id === state.activeChatId) {
      btn.classList.add("active");
    }
    btn.textContent = chat.title || "Untitled chat";
    btn.addEventListener("click", () => {
      state.activeChatId = chat.id;
      saveState();
      render();
    });
    elements.chatList.appendChild(btn);
  });
}

function renderMessages() {
  const chat = getActiveChat();
  elements.messages.innerHTML = "";
  if (!chat) return;

  chat.messages
    .filter((message) => message.role !== "system")
    .forEach((message) => {
      const article = document.createElement("article");
      const isEditing = state.editingMessageId === message.id;
      article.className = `message message--${message.role}`;
      if (isEditing) {
        article.classList.add("message--editing");
      }

      const head = document.createElement("header");
      head.className = "message__head";
      const roleLabel = document.createElement("span");
      roleLabel.className = "message__role";
      roleLabel.textContent =
        message.role === "assistant" ? "Assistant" : "You";
      head.appendChild(roleLabel);

      const controls = document.createElement("div");
      controls.className = "message__controls";

      if (isEditing) {
        controls.classList.add("message__controls--editing");
        controls.textContent = "Editing…";
      } else {
        if (message.role === "assistant") {
          const speakBtn = document.createElement("button");
          speakBtn.className = "btn ghost";
          speakBtn.textContent = "Speak";
          speakBtn.addEventListener("click", () =>
            speakAssistantMessage(message.id)
          );
          controls.appendChild(speakBtn);

          const copyBtn = document.createElement("button");
          copyBtn.className = "btn ghost";
          copyBtn.textContent = "Copy";
          copyBtn.addEventListener("click", () => copyMessage(message.content));
          controls.appendChild(copyBtn);
        }

        const editBtn = document.createElement("button");
        editBtn.className = "btn ghost";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => startEditingMessage(message.id));
        controls.appendChild(editBtn);

        const branchBtn = document.createElement("button");
        branchBtn.className = "btn ghost";
        branchBtn.textContent = "Branch";
        branchBtn.addEventListener("click", () =>
          branchChatFromMessage(message.id)
        );
        controls.appendChild(branchBtn);
      }

      head.appendChild(controls);

      if (isEditing) {
        const editor = document.createElement("textarea");
        const editingValue = state.editingValue ?? "";
        editor.className = "message__editor";
        editor.value = editingValue;
        editor.setAttribute("data-edit-id", message.id);
        editor.rows = Math.max(3, editingValue.split("\n").length + 1);
        editor.addEventListener("input", (event) => {
          state.editingValue = event.target.value;
        });
        editor.addEventListener("keydown", (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            saveEditedMessage();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelEditingMessage();
          }
        });

        const actions = document.createElement("div");
        actions.className = "message__editor-actions";

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn ghost";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", cancelEditingMessage);

        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "btn primary";
        saveBtn.textContent = "Save";
        saveBtn.addEventListener("click", saveEditedMessage);

        actions.append(cancelBtn, saveBtn);
        article.append(head, editor, actions);
      } else {
        const content = document.createElement("pre");
        content.className = "message__content";
        content.textContent = message.content;
        article.append(head, content);
      }

      elements.messages.appendChild(article);
    });

  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function updateStatus() {
  elements.status.textContent = state.status || "";
}

function updateControls() {
  elements.pendingIndicator.classList.toggle("hidden", !state.pending);
  const noModel = !state.model;
  const noVoice = !state.voice;
  elements.redoBtn.disabled = state.pending || noModel || noVoice || !canRedo();
  const disabled = state.pending || noModel || noVoice;
  elements.promptInput.disabled = disabled;
  elements.composer.querySelector("button[type=submit]").disabled = disabled;
  elements.modelSelect.disabled = !state.models.length;
  elements.voiceSelect.disabled = !state.voices.length;
  if (elements.stopAudioBtn) {
    elements.stopAudioBtn.disabled = !state.audioPlaying;
  }
}

function canRedo() {
  const chat = getActiveChat();
  if (!chat || chat.messages.length < 2) return false;
  return chat.messages[chat.messages.length - 1].role === "assistant";
}

async function requestAssistantResponse(chat) {
  if (!chat) return;
  if (!state.model) {
    setStatus("No LM Studio model available.");
    return;
  }
  if (!state.voice) {
    setStatus("No Kokoro voice selected.");
    return;
  }
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.role !== "user") return;

  setPending(true);
  setStatus("");

  try {
    const payload = {
      messages: chat.messages.map(({ role, content }) => ({ role, content })),
      temperature: state.temperature,
      model: state.model,
      voice: state.voice,
    };
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to generate response");
    }

    const assistantMessage = {
      id: newId(),
      role: "assistant",
      content: (data.content || "").trim(),
      createdAt: new Date().toISOString(),
      voice: data.voice || state.voice,
    };
    if (data.audio) {
      assistantMessage.audioUrl = `data:audio/wav;base64,${data.audio}`;
    }

    chat.messages.push(assistantMessage);
    saveState();
    renderMessages();
    updateControls();

    if (assistantMessage.audioUrl) {
      playAudio(assistantMessage.audioUrl);
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Something went wrong");
  } finally {
    setPending(false);
  }
}

function setPending(flag) {
  state.pending = flag;
  updateControls();
}

async function speakAssistantMessage(messageId) {
  const chat = getActiveChat();
  if (!chat) return;
  const message = chat.messages.find((m) => m.id === messageId);
  if (!message) return;
  const selectedVoice = state.voice;
  if (!selectedVoice) {
    setStatus("No Kokoro voice selected.");
    return;
  }

  try {
    if (message.audioUrl && message.voice === selectedVoice) {
      playAudio(message.audioUrl);
      return;
    }
    setStatus("Generating speech…", false);
    const audioUrl = await fetchTTS(message.content, selectedVoice);
    message.audioUrl = audioUrl;
    message.voice = selectedVoice;
    saveState();
    playAudio(audioUrl);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Failed to synthesize audio");
  } finally {
    setTimeout(() => setStatus(""), 1500);
  }
}

async function fetchTTS(text, voice) {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "TTS error");
  }
  return `data:audio/wav;base64,${data.audio}`;
}

function playAudio(source) {
  stopAudio(false);

  const audio = new Audio(source);
  audioPlayer = audio;
  state.audioPlaying = true;
  updateControls();

  const handleAudioFinished = () => {
    if (audioPlayer === audio) {
      audioPlayer = null;
      state.audioPlaying = false;
      updateControls();
    }
  };

  audio.addEventListener("ended", handleAudioFinished);
  audio.addEventListener("error", (event) => {
    console.error("Audio playback failed", event);
    setStatus("Unable to play audio (check browser permissions).");
    stopAudio(false);
  });

  audio.play().catch((error) => {
    console.error("Audio playback failed", error);
    setStatus("Unable to play audio (check browser permissions).");
    stopAudio(false);
  });
}

function stopAudio(showStatus = false) {
  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    audioPlayer = null;
  }
  if (state.audioPlaying) {
    state.audioPlaying = false;
    updateControls();
  }
  if (showStatus) {
    setStatus("Audio stopped.", false);
  }
}

function copyMessage(text) {
  navigator.clipboard
    .writeText(text)
    .then(() => setStatus("Copied!", false))
    .catch(() => setStatus("Copy failed"));
}

function startEditingMessage(messageId) {
  const chat = getActiveChat();
  if (!chat) return;
  const message = chat.messages.find((m) => m.id === messageId);
  if (!message || message.role === "system") return;

  state.editingMessageId = messageId;
  state.editingValue = message.content;
  renderMessages();

  const focusEditor = () => {
    const textarea = elements.messages.querySelector(
      `textarea[data-edit-id="${messageId}"]`
    );
    if (textarea) {
      textarea.focus();
      const length = textarea.value.length;
      textarea.setSelectionRange(length, length);
    }
  };

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(focusEditor);
  } else {
    setTimeout(focusEditor, 0);
  }
}

function cancelEditingMessage() {
  state.editingMessageId = null;
  state.editingValue = "";
  renderMessages();
}

function saveEditedMessage() {
  const messageId = state.editingMessageId;
  if (!messageId) return;

  const chat = getActiveChat();
  if (!chat) return;

  const index = chat.messages.findIndex((m) => m.id === messageId);
  if (index === -1) return;

  const message = chat.messages[index];
  const trimmed = state.editingValue.trim();

  if (!trimmed) {
    setStatus("Message cannot be empty.");
    return;
  }

  if (message.content === trimmed) {
    cancelEditingMessage();
    setStatus("No changes made.", false);
    return;
  }

  message.content = trimmed;

  if (message.role === "assistant") {
    delete message.audioUrl;
    saveState();
    cancelEditingMessage();
    setStatus("Assistant message updated.", false);
    return;
  }

  if (message.role === "user") {
    chat.messages = chat.messages.slice(0, index + 1);
    saveState();
    cancelEditingMessage();
    requestAssistantResponse(chat);
  }
}

function branchChatFromMessage(messageId) {
  const chat = getActiveChat();
  if (!chat) return;
  const index = chat.messages.findIndex((m) => m.id === messageId);
  if (index === -1) return;

  const newChat = {
    id: newId(),
    title: chat.title,
    createdAt: new Date().toISOString(),
    messages: chat.messages.slice(0, index + 1).map((message) => ({ ...message })),
  };

  updateChatTitle(newChat);
  state.chats.unshift(newChat);
  state.activeChatId = newChat.id;
  saveState();
  render();
  if (elements.promptInput) {
    elements.promptInput.focus();
  }
  setStatus("Branched chat created.", false);
}

function setStatus(message, isError = true) {
  state.status = message;
  elements.status.textContent = message || "";
  if (!message) {
    elements.status.style.color = "#94a3b8";
    return;
  }
  elements.status.style.color = isError ? "#f87171" : "#4ade80";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2, 10)}`;
}

async function refreshModels() {
  try {
    const response = await fetch("/api/models");
    const data = await response.json();
    state.models = data.models || [];

    if (!state.models.length) {
      state.model = null;
      localStorage.removeItem(MODEL_KEY);
      setStatus("No model is currently loaded in LM Studio.");
    } else {
      if (!state.model || !state.models.includes(state.model)) {
        state.model = state.models[0];
        localStorage.setItem(MODEL_KEY, state.model);
      }
      if (state.status === "No model is currently loaded in LM Studio.") {
        setStatus("");
      }
    }
  } catch (error) {
    console.error(error);
    setStatus("Unable to fetch LM Studio models.");
  } finally {
    renderModelSelect();
    updateControls();
  }
}

async function refreshVoices() {
  try {
    const response = await fetch("/api/voices");
    const data = await response.json();
    state.voices = data.voices || [];

    if (!state.voices.length) {
      state.voice = null;
      localStorage.removeItem(VOICE_KEY);
      setStatus("No Kokoro voices are available.");
    } else {
      const defaultVoice = data.default;
      const hasCurrent = state.voices.some((voice) => voice.name === state.voice);
      if (!hasCurrent) {
        const fallback =
          state.voices.find((voice) => voice.name === defaultVoice)?.name ||
          state.voices[0].name;
        state.voice = fallback;
        localStorage.setItem(VOICE_KEY, fallback);
      }
      if (
        state.status === "No Kokoro voices are available." ||
        state.status === "Unable to fetch Kokoro voices."
      ) {
        setStatus("");
      }
    }
  } catch (error) {
    console.error(error);
    setStatus("Unable to fetch Kokoro voices.");
  } finally {
    renderVoiceSelect();
    updateControls();
  }
}

function renderModelSelect() {
  const select = elements.modelSelect;
  if (!select) return;

  select.innerHTML = "";

  if (!state.models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No models";
    select.appendChild(option);
    select.value = "";
    select.disabled = true;
    return;
  }

  state.models.forEach((model) => {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  });
  select.disabled = false;
  select.value = state.model || state.models[0];
}

function renderVoiceSelect() {
  const select = elements.voiceSelect;
  if (!select) return;

  select.innerHTML = "";

  if (!state.voices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No voices";
    select.appendChild(option);
    select.value = "";
    select.disabled = true;
    return;
  }

  state.voices.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang_code})`;
    select.appendChild(option);
  });

  select.disabled = false;
  select.value = state.voice || state.voices[0].name;
}
