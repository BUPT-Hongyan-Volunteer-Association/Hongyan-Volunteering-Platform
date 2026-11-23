import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue';

/** 跨页按学生/记录 ID 维护选择；分页只提供当前页 ID，选中集合由调用方决定何时清空。 */
export function useIdSelection(pageIdsSource: MaybeRefOrGetter<string[]>) {
  const selected = ref(new Set<string>());
  const pageIds = computed(() => [...new Set(toValue(pageIdsSource))]);
  const pageChecked = computed(
    () => pageIds.value.length > 0 && pageIds.value.every((id) => selected.value.has(id)),
  );
  const pageIndeterminate = computed(
    () => !pageChecked.value && pageIds.value.some((id) => selected.value.has(id)),
  );
  function togglePage(checked: boolean) {
    const next = new Set(selected.value);
    for (const id of pageIds.value) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    selected.value = next;
  }
  function toggleStudent(id: string, checked: boolean) {
    const next = new Set(selected.value);
    if (checked) next.add(id);
    else next.delete(id);
    selected.value = next;
  }
  function clear() {
    selected.value.clear();
  }
  return { selected, pageIds, pageChecked, pageIndeterminate, togglePage, toggleStudent, clear };
}
