ALTER TABLE "auth_user" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_username_unique" UNIQUE("username");