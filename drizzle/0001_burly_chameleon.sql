CREATE TABLE `branches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`code` varchar(32) NOT NULL,
	`city` varchar(80) NOT NULL,
	`isActive` enum('yes','no') NOT NULL DEFAULT 'yes',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `branches_id` PRIMARY KEY(`id`),
	CONSTRAINT `branches_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `cashboxTransactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`branchId` int NOT NULL,
	`transactionType` enum('income','expense','transfer') NOT NULL,
	`amount` decimal(12,2) NOT NULL,
	`reservationId` int,
	`description` varchar(320) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cashboxTransactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`branchId` int NOT NULL,
	`category` varchar(80) NOT NULL,
	`amount` decimal(12,2) NOT NULL,
	`paidFrom` enum('cash','bank') NOT NULL,
	`occurredAt` timestamp NOT NULL,
	`notes` text,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `expenses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tripId` int NOT NULL,
	`branchId` int NOT NULL,
	`passengerName` varchar(120) NOT NULL,
	`passengerPhone` varchar(32) NOT NULL,
	`seatNumber` varchar(8) NOT NULL,
	`price` decimal(12,2) NOT NULL,
	`paidAmount` decimal(12,2) NOT NULL,
	`paymentStatus` enum('paid','partial','unpaid') NOT NULL DEFAULT 'unpaid',
	`reservationStatus` enum('confirmed','pending','cancelled') NOT NULL DEFAULT 'confirmed',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reservations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `trips` (
	`id` int AUTO_INCREMENT NOT NULL,
	`routeName` varchar(180) NOT NULL,
	`departureAt` timestamp NOT NULL,
	`busNumber` varchar(50) NOT NULL,
	`driverName` varchar(120) NOT NULL,
	`capacity` int NOT NULL,
	`status` enum('open','boarding','departed','closed') NOT NULL DEFAULT 'open',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `trips_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `userBranches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`branchId` int NOT NULL,
	`assignedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `userBranches_id` PRIMARY KEY(`id`),
	CONSTRAINT `userBranches_userId_unique` UNIQUE(`userId`)
);
