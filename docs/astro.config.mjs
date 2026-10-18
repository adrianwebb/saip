import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://adrianwebb.github.io',
  base: '/saip',
  integrations: [
    starlight({
      title: 'SAIP Documentation',
      description: 'Simple AI Platform — continual learning with QLoRA adapters',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/adrianwebb/saip',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/adrianwebb/saip/edit/staging/docs/',
      },
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'Introduction', slug: 'index' },
            { label: 'Getting Started', slug: 'tutorials/getting-started' },
            { label: 'Training Your First Adapter', slug: 'tutorials/training-your-first-adapter' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Deploy Locally', slug: 'guides/deploy-local' },
            { label: 'Deploy to Hyperstack', slug: 'guides/deploy-hyperstack' },
            { label: 'Configure Adapters', slug: 'guides/configure-adapters' },
            { label: 'Submit Knowledge', slug: 'guides/submit-knowledge' },
            { label: 'Submit Feedback', slug: 'guides/submit-feedback' },
            { label: 'Manage Secrets', slug: 'guides/manage-secrets' },
            { label: 'CLI Reference', slug: 'guides/cli-reference' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration (saip.yaml)', slug: 'reference/configuration' },
            { label: 'R2 Bucket Layout', slug: 'reference/r2-bucket-layout' },
            { label: 'Inference & Data API', slug: 'reference/api-inference' },
            { label: 'Learning API', slug: 'reference/api-training' },
            { label: 'Adapter Manifest', slug: 'reference/adapter-manifest' },
            { label: 'Cordis Plugins', slug: 'reference/cordis-plugins' },
            { label: 'Glossary', slug: 'reference/glossary' },
          ],
        },
        {
          label: 'Understanding SAIP',
          items: [
            { label: 'Architecture', slug: 'explanation/architecture' },
            { label: 'The Learning Loop', slug: 'explanation/learning-loop' },
            { label: 'Training Methods', slug: 'explanation/training-methods' },
            { label: 'Adapter Composition', slug: 'explanation/adapter-composition' },
            { label: 'Cordis Plugin Model', slug: 'explanation/cordis-plugin-model' },
          ],
        },
      ],
      customCss: [],
    }),
  ],
});
