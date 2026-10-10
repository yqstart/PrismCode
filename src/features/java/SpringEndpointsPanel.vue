<script setup lang="ts">
// ==================== Spring 端点工具窗口 ====================
// 右侧栏只读面板：列出 Spring 索引扫描出的 HTTP 端点（方法 / 路由 / 位置），
// 点击跳转到对应控制器行。数据来自 java store 的 springIndex（有界扫描 + 3 秒预算），
// 面板首次挂载时惰性触发索引。
import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { Refresh, Route } from "reicon-vue";
import { useEditorStore } from "@/stores/editor";
import { useJavaStore } from "@/stores/java";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";
import type { SpringEndpoint } from "@/shared/springIndex";

const { t } = useI18n();
const java = useJavaStore();
const workspace = useWorkspaceStore();
const editor = useEditorStore();
const { springIndex, springLoading } = storeToRefs(java);
const { rootPath } = storeToRefs(workspace);

const filter = ref("");

/** 端点排序：路由优先，其次方法；过滤按路由 / 方法 / 文件路径匹配 */
const endpoints = computed<SpringEndpoint[]>(() => {
  const query = filter.value.trim().toLowerCase();
  const list = springIndex.value.endpoints.filter((item) => {
    if (!query) return true;
    return (
      item.route.toLowerCase().includes(query) ||
      item.method.toLowerCase().includes(query) ||
      item.path.toLowerCase().includes(query)
    );
  });
  return [...list].sort((a, b) => {
    if (a.route !== b.route) return a.route < b.route ? -1 : 1;
    if (a.method !== b.method) return a.method < b.method ? -1 : 1;
    return a.line - b.line;
  });
});

const hasWorkspace = computed(() => Boolean(rootPath.value));
const loaded = computed(() => springIndex.value.endpoints.length > 0);

function openEndpoint(endpoint: SpringEndpoint) {
  const root = rootPath.value;
  if (!root) return;
  const absolute = endpoint.path.startsWith("/")
    ? endpoint.path
    : `${root}/${endpoint.path}`;
  editor.requestOpenAt(absolute, endpoint.line, 1);
}

onMounted(() => {
  void java.ensureSpringIndex();
});
</script>

<template>
  <div class="spring-panel">
    <div class="toolbar">
      <input
        v-model="filter"
        class="filter-input"
        type="text"
        :placeholder="t('spring.panel.filter')"
        :disabled="!loaded"
      />
      <button
        type="button"
        class="refresh-btn"
        :title="t('spring.action.refresh')"
        :disabled="springLoading || !hasWorkspace"
        @click="java.refreshSpringIndex()"
      >
        <Refresh weight="Filled" :size="14" :class="{ spinning: springLoading }" />
      </button>
    </div>

    <div v-if="!hasWorkspace" class="empty">
      <Route weight="Filled" :size="28" class="empty-icon" />
      <p>{{ t("spring.panel.noWorkspace") }}</p>
    </div>
    <div v-else-if="springLoading && !loaded" class="empty">
      <p>{{ t("spring.panel.loading") }}</p>
    </div>
    <div v-else-if="!endpoints.length" class="empty">
      <Route weight="Filled" :size="28" class="empty-icon" />
      <p>{{ loaded ? t("spring.panel.noMatch") : t("spring.panel.empty") }}</p>
    </div>
    <div v-else class="list">
      <button
        v-for="endpoint in endpoints"
        :key="`${endpoint.method} ${endpoint.route} ${endpoint.path}:${endpoint.line}`"
        type="button"
        class="endpoint"
        :title="`${endpoint.path}:${endpoint.line}`"
        @click="openEndpoint(endpoint)"
      >
        <span class="method" :class="`method-${endpoint.method.toLowerCase()}`">
          {{ endpoint.method }}
        </span>
        <span class="route">{{ endpoint.route }}</span>
        <span class="loc">{{ endpoint.path }}:{{ endpoint.line }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.spring-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.filter-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.filter-input:focus {
  outline: none;
  border-color: var(--accent);
}

.refresh-btn {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
}

.refresh-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.refresh-btn:disabled {
  opacity: 0.4;
}

.spinning {
  animation: spring-panel-spin 0.9s linear infinite;
}

@keyframes spring-panel-spin {
  to {
    transform: rotate(360deg);
  }
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.endpoint {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  transition: background var(--transition-fast);
}

.endpoint:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.method {
  flex-shrink: 0;
  width: 48px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-muted);
}

/* HTTP 方法语义色：GET 蓝 / POST 绿 / PUT 黄 / DELETE 红 / PATCH 紫 */
.method-get {
  color: var(--accent);
}
.method-post {
  color: var(--success);
}
.method-put {
  color: var(--warning);
}
.method-delete {
  color: var(--danger);
}
.method-patch {
  color: var(--text-primary);
}

.route {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
}

.loc {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: right;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
}

.empty-icon {
  opacity: 0.5;
}
</style>
