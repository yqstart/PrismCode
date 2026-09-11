<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useAppUpdateStore } from "@/stores/appUpdate";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const appUpdate = useAppUpdateStore();
const {
  downloading,
  availableVersion,
  downloadedBytes,
  contentLength,
  progressPercent,
} = storeToRefs(appUpdate);

const sizeLabel = computed(() => {
  const done = formatBytes(downloadedBytes.value);
  const total = contentLength.value;
  if (total && total > 0) {
    return `${done} / ${formatBytes(total)}`;
  }
  return done;
});

const barWidth = computed(() => {
  if (progressPercent.value != null) return `${progressPercent.value}%`;
  // 未知总长时用不确定进度的脉冲视觉（宽度固定一段）
  return "36%";
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <div
    v-if="downloading"
    class="overlay"
    role="dialog"
    aria-modal="true"
    :aria-label="t('update.downloadingTitle')"
  >
    <div class="dialog">
      <h3 class="title">{{ t("update.downloadingTitle") }}</h3>
      <p class="message">
        {{
          t("update.downloadingMessage", {
            version: availableVersion ?? "",
          })
        }}
      </p>
      <div
        class="track"
        :class="{ indeterminate: progressPercent == null }"
      >
        <div class="fill" :style="{ width: barWidth }" />
      </div>
      <div class="meta">
        <span v-if="progressPercent != null">{{ progressPercent }}%</span>
        <span v-else>{{ t("update.downloading") }}</span>
        <span>{{ sizeLabel }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 85;
  display: grid;
  place-items: center;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  animation: prism-overlay-in var(--transition-normal) var(--ease-out);
  padding: 24px;
}

.dialog {
  width: min(420px, 100%);
  animation: prism-dialog-in var(--transition-normal) var(--ease-out);
  padding: 18px 18px 16px;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.message {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.track {
  height: 8px;
  border-radius: 999px;
  background: var(--bg-app);
  border: 1px solid var(--border-subtle);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 120ms linear;
}

.track.indeterminate .fill {
  animation: indeterminate 1.1s ease-in-out infinite;
}

.meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

@keyframes indeterminate {
  0% {
    transform: translateX(-120%);
  }
  100% {
    transform: translateX(320%);
  }
}
</style>
