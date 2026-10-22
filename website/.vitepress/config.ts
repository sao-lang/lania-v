import { defineConfig } from 'vitepress';

const guideSidebar = [
  {
    text: '开始',
    items: [
      { text: '为什么是 lania-v', link: '/guide/introduction' },
      { text: '快速开始', link: '/guide/getting-started' },
      { text: '特性总览', link: '/guide/features' },
      { text: '编译模型', link: '/guide/compilation-model' },
    ],
  },
  {
    text: '核心能力',
    items: [
      { text: '响应式基础', link: '/guide/reactivity' },
      { text: '模板与绑定', link: '/guide/templates' },
      { text: '语法参考', link: '/guide/syntax' },
      { text: '组件', link: '/guide/components' },
      { text: '插槽', link: '/guide/slots' },
      { text: '上下文', link: '/guide/context' },
      { text: '条件与列表', link: '/guide/control-flow' },
      { text: '异步与边界', link: '/guide/async-and-boundaries' },
      { text: '状态管理', link: '/guide/state' },
      { text: '过渡与缓存', link: '/guide/transitions-and-cache' },
    ],
  },
  {
    text: '工程化',
    items: [
      { text: '工程配置', link: '/guide/configuration' },
      { text: '构建与部署', link: '/guide/build-and-deploy' },
      { text: 'SSR 与部分水合', link: '/guide/ssr' },
      { text: '开发与调试', link: '/guide/dev-and-debug' },
      { text: '最佳实践', link: '/guide/best-practices' },
      { text: '常见问题与排错', link: '/guide/troubleshooting' },
    ],
  },
];

const apiSidebar = [
  {
    text: 'API 参考',
    items: [
      { text: 'API 总览', link: '/api/' },
      { text: '响应式 API', link: '/api/reactivity' },
      { text: '组件 API', link: '/api/component' },
      { text: 'DOM 与绑定 API', link: '/api/dom' },
      { text: '增强组件 API', link: '/api/enhanced-components' },
      { text: '编译期 API', link: '/api/compile-time' },
      { text: 'SSR API', link: '/api/ssr' },
      { text: 'Vite 插件', link: '/api/plugin' },
      { text: '包与导出入口', link: '/api/packages' },
    ],
  },
];

const advancedSidebar = [
  {
    text: '深入实现',
    items: [
      { text: '整体架构', link: '/advanced/architecture' },
      { text: '更新链路', link: '/advanced/update-pipeline' },
      { text: '编译管线', link: '/advanced/compiler-pipeline' },
    ],
  },
];

const examplesSidebar = [
  {
    text: '示例',
    items: [
      { text: 'Todo 列表', link: '/examples/todo' },
      { text: '登录表单', link: '/examples/login' },
    ],
  },
];

// GitHub Pages 项目站点部署在 https://sao-lang.github.io/lania-v/
const base = '/lania-v/';

export default defineConfig({
  lang: 'zh-CN',
  title: 'lania-v',
  description: '编译优先的细粒度 Web Components 框架',
  base,
  cleanUrls: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }],
    ['meta', { name: 'theme-color', content: '#7c3aed' }],
  ],
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'lania-v',
    nav: [
      { text: '指南', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: 'API', link: '/api/', activeMatch: '/api/' },
      {
        text: '深入',
        link: '/advanced/architecture',
        activeMatch: '/advanced/',
      },
      { text: '示例', link: '/examples/todo', activeMatch: '/examples/' },
    ],
    sidebar: {
      '/guide/': guideSidebar,
      '/api/': apiSidebar,
      '/advanced/': advancedSidebar,
      '/examples/': examplesSidebar,
    },
    outline: {
      level: [2, 3],
      label: '本页目录',
    },
    docFooter: {
      prev: '上一页',
      next: '下一页',
    },
    lastUpdated: {
      text: '最后更新',
    },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档',
          },
          modal: {
            noResultsText: '没有找到相关结果',
            resetButtonTitle: '清除查询',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/sao-lang/lania-v' },
    ],
    footer: {
      message: '基于 MIT License 发布',
      copyright: 'Copyright © lania-v contributors',
    },
  },
});
