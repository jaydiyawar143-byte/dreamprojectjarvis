import { prisma } from "./index.js";

async function seed() {
  console.log("Seeding database...");

  await prisma.agent.createMany({
    skipDuplicates: true,
    data: [
      {
        name: "conversational-assistant",
        description: "Core AI conversational assistant",
        category: "ai-core",
        config: { model: "gpt-4", temperature: 0.7 },
      },
      {
        name: "marketing-agent",
        description: "Marketing strategy and execution agent",
        category: "marketing",
        config: { model: "gpt-4", temperature: 0.7 },
      },
      {
        name: "seo-agent",
        description: "SEO analysis and optimization agent",
        category: "marketing",
        config: { model: "gpt-4", temperature: 0.3 },
      },
      {
        name: "social-media-agent",
        description: "Social media management agent",
        category: "marketing",
        config: { model: "gpt-4", temperature: 0.7 },
      },
      {
        name: "research-agent",
        description: "Web research and data gathering agent",
        category: "research",
        config: { model: "gpt-4", temperature: 0.3 },
      },
      {
        name: "executive-assistant",
        description: "Task management and scheduling agent",
        category: "productivity",
        config: { model: "gpt-4", temperature: 0.5 },
      },
    ],
  });

  console.log("Database seeded successfully!");
}

seed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
