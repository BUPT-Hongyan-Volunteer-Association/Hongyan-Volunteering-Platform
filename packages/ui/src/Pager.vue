<script setup lang="ts">
defineProps<{page:number;size:number;total:number}>();
defineEmits<{change:[page:number]}>();
</script>
<template><nav class="pager" aria-label="分页">
 <button :disabled="page<=1" @click="$emit('change',page-1)">上一页</button>
 <span>第 {{page}} / {{Math.max(1,Math.ceil(total/size))}} 页</span>
 <button :disabled="page*size>=total" @click="$emit('change',page+1)">下一页</button>
</nav></template>
<style scoped>.pager {display:flex;align-items:center;gap:12px;margin:16px 0;}</style>
