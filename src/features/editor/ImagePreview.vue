<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Minus, Plus, RotateCcw, Maximize2 } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import {
  isRasterImagePath,
  isSvgPath,
  rasterDataUrl,
  svgDataUrl,
} from "@/shared/media";
import { useWorkspaceStore } from "@/stores/workspace";
import { fileScopeRoot } from "@/shared/fileScope";
import { useI18n } from "@/i18n";

const props = defineProps<{
  path: string;
  /** SVG 文本内容（有则用 data URL 预览） */
  content?: string;
  /** 外部变更时递增以刷新 */
  cacheKey?: number;
}>();

const workspace = useWorkspaceStore();
const { t } = useI18n();
const { rootPath } = storeToRefs(workspace);

const stageRef = ref<HTMLElement | null>(null);
const src = ref("");
const natural = ref<{ w: number; h: number } | null>(null);
const loadError = ref<string | null>(null);
const loading = ref(true);
/** 相对原图像素的缩放倍率 */
const zoom = ref(1);
const fitZoom = ref(1);
let loadSeq = 0;

const zoomLabel = computed(() => `${Math.round(zoom.value * 100)}%`);

const imgStyle = computed(() => {
  if (!natural.value) return {};
  return {
    width: `${Math.max(1, natural.value.w * zoom.value)}px`,
    height: "auto",
  };
});

function clampZoom(v: number) {
  return Math.min(32, Math.max(0.05, v));
}

function computeFitZoom() {
  if (!natural.value || !stageRef.value) return 1;
  const pad = 48;
  const aw = Math.max(1, stageRef.value.clientWidth - pad);
  const ah = Math.max(1, stageRef.value.clientHeight - pad);
  return Math.min(aw / natural.value.w, ah / natural.value.h, 1);
}

function fitToWindow() {
  fitZoom.value = computeFitZoom();
  zoom.value = fitZoom.value;
}

function zoomBy(factor: number) {
  zoom.value = clampZoom(zoom.value * factor);
}

function zoomToActual() {
  zoom.value = 1;
}

function onWheel(event: WheelEvent) {
  if (loadError.value || !natural.value) return;
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
  zoom.value = clampZoom(zoom.value * factor);
}

async function reload() {
  const seq = ++loadSeq;
  loading.value = true;
  loadError.value = null;
  natural.value = null;
  src.value = "";
  zoom.value = 1;

  try {
    if (isSvgPath(props.path) && props.content != null && props.content.length > 0) {
      const url = svgDataUrl(props.content);
      if (seq !== loadSeq) return;
      src.value = url;
      return;
    }

    const scope = fileScopeRoot(rootPath.value, props.path);
    if (!scope) {
      throw new Error(t("editor.image.noWorkspace"));
    }
    const url = await rasterDataUrl(scope, props.path);
    if (seq !== loadSeq) return;
    src.value = url;
  } catch (error) {
    if (seq !== loadSeq) return;
    loading.value = false;
    loadError.value =
      error instanceof Error
        ? error.message
        : String(error) || t("editor.image.previewUnavailable");
  }
}

async function onLoad(event: Event) {
  loading.value = false;
  loadError.value = null;
  const img = event.target as HTMLImageElement;
  natural.value = { w: img.naturalWidth, h: img.naturalHeight };
  await nextTick();
  fitToWindow();
}

function onError() {
  loading.value = false;
  natural.value = null;
  loadError.value = t("editor.image.previewUnavailable");
}

watch(
  () => [props.path, props.cacheKey, props.content, rootPath.value] as const,
  () => {
    void reload();
  },
  { immediate: true },
);
</script>

<template>
  <div class="image-preview" :data-raster="isRasterImagePath(path)">
    <div
      ref="stageRef"
      class="stage"
      @wheel.prevent="onWheel"
    >
      <div v-if="loading && !loadError" class="hint">{{ t("editor.image.loading") }}</div>
      <div v-if="loadError" class="hint error">{{ loadError }}</div>
      <img
        v-show="src && !loadError"
        :key="src"
        class="img"
        :src="src"
        :alt="path"
        :style="imgStyle"
        draggable="false"
        @load="onLoad"
        @error="onError"
      />
    </div>
    <div class="footer">
      <span class="path">{{ path }}</span>
      <div class="zoom-bar">
        <button
          type="button"
          class="zbtn"
          :title="t('editor.image.zoomOut')"
          :disabled="!natural"
          @click="zoomBy(1 / 1.25)"
        >
          <Minus :size="12" />
        </button>
        <span class="zoom-label" :title="t('editor.image.wheelZoomHint')">{{ zoomLabel }}</span>
        <button
          type="button"
          class="zbtn"
          :title="t('editor.image.zoomIn')"
          :disabled="!natural"
          @click="zoomBy(1.25)"
        >
          <Plus :size="12" />
        </button>
        <button
          type="button"
          class="zbtn"
          :title="t('editor.image.actualSize')"
          :disabled="!natural"
          @click="zoomToActual"
        >
          <RotateCcw :size="12" />
        </button>
        <button
          type="button"
          class="zbtn"
          :title="t('editor.image.fitWindow')"
          :disabled="!natural"
          @click="fitToWindow"
        >
          <Maximize2 :size="12" />
        </button>
        <span v-if="natural" class="size">{{ natural.w }} × {{ natural.h }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.image-preview {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
}

.stage {
  flex: 1;
  min-height: 0;
  position: relative;
  display: grid;
  place-items: center;
  padding: 24px;
  overflow: auto;
  background: var(--bg-editor);
}

.img {
  display: block;
  max-width: none;
  max-height: none;
  object-fit: contain;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
  background-color: #fff;
  background-image:
    linear-gradient(45deg, #e8e8e8 25%, transparent 25%),
    linear-gradient(-45deg, #e8e8e8 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #e8e8e8 75%),
    linear-gradient(-45deg, transparent 75%, #e8e8e8 75%);
  background-size: 16px 16px;
  background-position:
    0 0,
    0 8px,
    8px -8px,
    -8px 0;
}

.hint {
  position: absolute;
  color: var(--text-muted);
  font-size: 13px;
}

.hint.error {
  color: var(--danger);
}

.footer {
  flex-shrink: 0;
  height: 28px;
  padding: 0 10px 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-panel);
  font-size: 11px;
  color: var(--text-muted);
}

.path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zoom-bar {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.zbtn {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  border: 1px solid transparent;
}

.zbtn:hover:not(:disabled) {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--border-subtle);
}

.zbtn:disabled {
  opacity: 0.35;
}

.zoom-label {
  min-width: 44px;
  text-align: center;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.size {
  margin-left: 6px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
</style>
