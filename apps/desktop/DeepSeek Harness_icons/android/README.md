# Android 图标包说明

## 文件结构说明
- `res/mipmap-*/` - 启动器图标，用于应用图标显示
- `res/mipmap-anydpi-v26/` - Android 8.0+ 自适应图标配置
- `res/playstore-icon.png` - Play Store 图标 (512x512px)
- `res/values/colors.xml` - 图标相关颜色资源

## 集成步骤
1. 将 res 文件夹中的所有内容复制到您的 Android 项目的 src/main/res/ 目录
2. 在 AndroidManifest.xml 中引用图标（参考 AndroidManifest.xml 示例）
3. 根据需要调整 colors.xml 中的背景色
4. 将 playstore-icon.png 用于 Google Play Console 中的应用图标

## 自适应图标说明
- 支持 Android 8.0 (API 26)+ 设备
- 可在不同设备上显示为不同形状（圆形、方角、圆角等）
- 前景图标应在安全区域内（66dp）以避免被裁剪
- 包含 monochrome 层以支持 Android 13+ 的主题图标

## 图标尺寸规范
启动器图标：
- mdpi: 48x48px (密度比 1.0)
- hdpi: 72x72px (密度比 1.5)
- xhdpi: 96x96px (密度比 2.0)
- xxhdpi: 144x144px (密度比 3.0)
- xxxhdpi: 192x192px (密度比 4.0)

## Play Store 图标
- 尺寸：512x512px
- 格式：PNG，透明背景
- 用途：Google Play Console 应用列表和商店页面
- 要求：清晰、高质量，避免过多文字或细节

## 通知图标
本包默认不包含通知图标（drawable 资源）。如需要通知图标：
1. 通知图标应为单色白色设计，透明背景
2. 推荐使用简单的轮廓设计
3. 尺寸：mdpi: 24x24px 到 xxxhdpi: 96x96px

## 最佳实践
1. 使用矢量图形确保在所有密度下都清晰
2. 测试自适应图标在不同形状下的显示效果
3. 确保图标在暗色主题下也能清晰显示
4. 通知图标建议单独设计，不要直接使用应用图标

更多信息请参考：
- https://developer.android.com/guide/practices/ui_guidelines/icon_design
- https://developer.android.com/develop/ui/views/launch/icon_design_adaptive
