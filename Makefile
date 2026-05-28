install:
	pnpm install

dev:
	docker compose up -d mysql redis rabbitmq
	pnpm --parallel --filter backend --filter admin dev

infra:
	docker compose up -d mysql redis rabbitmq

migrate:
	pnpm --filter backend prisma:migrate

seed:
	pnpm --filter backend prisma:seed

test:
	pnpm --filter backend test

lint:
	pnpm lint

down:
	docker compose down
