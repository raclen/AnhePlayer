import { useTranslation } from 'react-i18next';
import { SettingsCard } from '../components/SettingsCard';
import { SettingRow } from '../components/SettingRow';
import { Input } from '@renderer/mainWindow/components/ui/Input';
import { CheckboxGroup } from '@renderer/mainWindow/components/ui/CheckboxGroup';
import { useConfigValue } from '@renderer/common/hooks/useConfigValue';
import { useBufferedConfigInput } from '../hooks/useBufferedConfigInput';
import { RoutePaths } from '@renderer/mainWindow/routes';

/** 可隐藏的侧边栏入口，取值与路由段常量保持一致 */
type HiddenNavItem = 'netease-recommend' | 'radio';

/** 隐藏侧边栏入口选项 */
const HIDDEN_NAV_OPTIONS: { value: HiddenNavItem; labelKey: string }[] = [
    { value: RoutePaths.NeteaseRecommend, labelKey: 'settings.customize.hide_netease' },
    { value: RoutePaths.Radio, labelKey: 'settings.customize.hide_radio' },
];

/** 校验选项值是否属于可隐藏入口，用于收窄 CheckboxGroup 的 string[] 返回值 */
function isHiddenNavItem(value: string): value is HiddenNavItem {
    return HIDDEN_NAV_OPTIONS.some((option) => option.value === value);
}

/**
 * 定制设置
 *
 * 配置项：customize.brandName、customize.hiddenNavItems
 * 品牌名为空时回退默认名称；隐藏项仅影响侧边栏入口，路由与页面本身保持可用。
 */
export function CustomizeSection() {
    const { t } = useTranslation();

    const brandName = useBufferedConfigInput('customize.brandName');
    const [hiddenNavItems, setHiddenNavItems] = useConfigValue('customize.hiddenNavItems');

    return (
        <SettingsCard
            title={t('settings.section_name.customize')}
            subtitle={t('settings.customize.subtitle')}
        >
            <SettingRow
                label={t('settings.customize.brand_name_label')}
                description={t('settings.customize.brand_name_desc')}
                control={
                    <Input
                        value={brandName.localValue}
                        onChange={brandName.handleChange}
                        onBlur={brandName.handleBlur}
                        placeholder="Anhe"
                        allowClear
                    />
                }
            />
            <SettingRow
                label={t('settings.customize.hidden_nav_label')}
                description={t('settings.customize.hidden_nav_desc')}
                control={
                    <CheckboxGroup
                        value={hiddenNavItems ?? []}
                        options={HIDDEN_NAV_OPTIONS.map((option) => ({
                            value: option.value,
                            label: t(option.labelKey),
                        }))}
                        onChange={(value) => setHiddenNavItems(value.filter(isHiddenNavItem))}
                    />
                }
            />
        </SettingsCard>
    );
}
