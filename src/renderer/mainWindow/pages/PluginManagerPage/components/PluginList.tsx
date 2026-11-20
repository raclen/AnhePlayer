import { useCallback, useMemo, useRef, useState } from 'react';
import {
    DndContext,
    closestCenter,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { Blocks } from 'lucide-react';
import { StatusPlaceholder } from '@renderer/mainWindow/components/ui/StatusPlaceholder';
import { RequestStatus } from '@common/constant';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import pluginManager from '@infra/pluginManager/renderer';
import { useSourceGroups, usePluginAvailability } from '@infra/pluginManager/renderer/hooks';
import PluginItem from './PluginItem';

const DND_MODIFIERS = [restrictToVerticalAxis];

/**
 * PluginList — 多音源列表（对齐移动端多音源结构）
 *
 * 以「音源包（脚本）」为维度展示与排序，通过开关互斥使用音源。
 */
export default function PluginList() {
    const sourceGroups = useSourceGroups();
    const availability = usePluginAvailability();
    const [changingSource, setChangingSource] = useState(false);
    const changingSourceRef = useRef(false);

    const sortedIds = useMemo(() => sourceGroups.map((g) => g.sourceHash), [sourceGroups]);

    const sensors = useSensors(useSensor(PointerSensor));

    const handleDragEnd = useCallback(
        (event: DragEndEvent) => {
            const { active, over } = event;
            if (!over || active.id === over.id) return;

            const oldIndex = sourceGroups.findIndex((g) => g.sourceHash === active.id);
            const newIndex = sourceGroups.findIndex((g) => g.sourceHash === over.id);
            if (oldIndex === -1 || newIndex === -1) return;

            const reordered = arrayMove(sourceGroups, oldIndex, newIndex);

            const updates = reordered.flatMap((g, i) =>
                g.delegates.map((d) => ({
                    hash: d.hash,
                    meta: { order: i * 10 },
                })),
            );

            pluginManager.batchSetPluginMeta(updates);
        },
        [sourceGroups],
    );

    const handleToggleEnabled = useCallback(
        async (sourceHash: string, enabled: boolean) => {
            const targetGroup = sourceGroups.find((g) => g.sourceHash === sourceHash);
            if (!targetGroup || changingSourceRef.current) return;

            changingSourceRef.current = true;
            setChangingSource(true);
            const previousActiveHash = pluginManager.getActiveSourceHash();
            const nextActiveHash = enabled
                ? sourceHash
                : targetGroup.isActive
                  ? ''
                  : previousActiveHash;
            // 启用时按整包互斥更新，保留内置本地音乐插件的独立状态。
            const updates = (enabled ? sourceGroups : [targetGroup]).flatMap((g) =>
                g.delegates.map((d) => ({
                    hash: d.hash,
                    meta: { enabled: enabled && g.sourceHash === sourceHash },
                })),
            );

            try {
                await pluginManager.setActiveSourceHash(nextActiveHash);
                await pluginManager.batchSetPluginMeta(updates, { throwOnError: true });
                if (enabled) {
                    showToast(`已使用音源：${targetGroup.name}，其他音源已禁用`);
                }
            } catch {
                // meta 保存失败会自行回滚，同时恢复之前的当前音源。
                try {
                    await pluginManager.setActiveSourceHash(previousActiveHash);
                } catch (error) {
                    console.error('恢复当前音源失败', error);
                }
                showToast('音源状态保存失败，请重试', { type: 'warn' });
            } finally {
                changingSourceRef.current = false;
                setChangingSource(false);
            }
        },
        [sourceGroups],
    );

    if (sourceGroups.length === 0) {
        return (
            <StatusPlaceholder
                status={RequestStatus.Done}
                isEmpty
                emptyIcon={Blocks}
                emptyTitle="尚未导入音源，请点击右上角「安装插件」导入本地或在线音源脚本"
            />
        );
    }

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={DND_MODIFIERS}
            onDragEnd={handleDragEnd}
        >
            <SortableContext items={sortedIds} strategy={verticalListSortingStrategy}>
                <div className="p-plugin-manager__list">
                    {sourceGroups.map((group) => (
                        <PluginItem
                            key={group.sourceHash}
                            sourceGroup={group}
                            availability={availability}
                            changingSource={changingSource}
                            onToggleEnabled={handleToggleEnabled}
                        />
                    ))}
                </div>
            </SortableContext>
        </DndContext>
    );
}
