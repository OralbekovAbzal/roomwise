function $(id) {
  return document.getElementById(id);
}

async function loadStatus() {
  const statusEl = $("key-status");
  const pathEl = $("key-file-path");
  try {
    const res = await fetch("/api/admin/gemini-key");
    const data = await res.json();
    statusEl.textContent = data.configured ? "Ключ настроен." : "Ключ не настроен. Укажите ниже или используйте переменную окружения Windows.";
    if (data.key_file) pathEl.textContent = "Файл ключа: " + data.key_file;
    else pathEl.textContent = "";
  } catch (err) {
    statusEl.textContent = "Не удалось проверить ключ.";
    pathEl.textContent = "";
  }
}

async function saveKey() {
  const value = $("api-key-input").value.trim();
  const statusEl = $("save-status");
  try {
    const res = await fetch("/api/admin/gemini-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = (data && data.detail && data.detail.message) || "Не удалось сохранить";
      statusEl.textContent = msg;
      return;
    }
    statusEl.textContent = "Сохранено.";
    $("api-key-input").value = "";
    loadStatus();
    setTimeout(() => (statusEl.textContent = ""), 2000);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Ошибка сети или сервера";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadStatus();
  $("save-key-btn").addEventListener("click", saveKey);
});
