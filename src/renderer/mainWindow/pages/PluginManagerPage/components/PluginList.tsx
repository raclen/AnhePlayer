import { useCallback, useMemo } from 'react';
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
import pluginManager, { type IPluginAvailabilityResult } from '@infra/pluginManager/renderer';
import { useSourceGroups, usePluginAvailability } from '@infra/pluginManager/renderer/hooks';
import PluginItem from './PluginItem';

const DND_MODIFIERS = [restrictToVerticalAxis];

/**
 * PluginList — 多音源列表（对齐移动端多音源结构）
 *
 * 以「音源包（脚本）」为维度展示与排序，支持多音源自由切换。
 */
export default function PluginList() {
    const sourceGroups = useSourceGroups();
    const availability = usePluginAvailability();

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
        (sourceHash: string, enabled: boolean) => {
            const targetGroup = sourceGroups.find((g) => g.sourceHash === sourceHash);
            if (!targetGroup) return;

            const updates = targetGroup.delegates.map((d) => ({
                hash: d.hash,
                meta: { enabled },
            }));
            pluginManager.batchSetPluginMeta(updates);
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
                    {sourceGroups.map((group) => {
                        const childAvailabilities = group.delegates
                            .map((d) => availability[d.hash])
                            .filter(Boolean);

                        let groupAvailability: IPluginAvailabilityResult | undefined;
                        if (childAvailabilities.some((a) => a.state === 'checking')) {
                            groupAvailability = { state: 'checking' };
                        } else if (childAvailabilities.length > 0) {
                            const hasAvailable = childAvailabilities.some(
                                (a) => a.state === 'available',
                            );
                            const hasUnavailable = childAvailabilities.some(
                                (a) => a.state === 'unavailable',
                            );
                            if (hasAvailable && !hasUnavailable) {
                                groupAvailability = { state: 'available' };
                            } else if (hasAvailable && hasUnavailable) {
                                groupAvailability = { state: 'available' }; // 部分或全部可用时标为可用
                            } else if (!hasAvailable && hasUnavailable) {
                                groupAvailability = {
                                    state: 'unavailable',
                                    message: childAvailabilities.find((a) => a.message)?.message,
                                };
                            }
                        }

                        return (
                            <PluginItem
                                key={group.sourceHash}
                                sourceGroup={group}
                                availability={groupAvailability}
                                onToggleEnabled={handleToggleEnabled}
                            />
                        );
                    })}
                </div>
            </SortableContext>
        </DndContext>
    );
}
