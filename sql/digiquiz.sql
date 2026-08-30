-- =====================================================================
-- DigiQuiz — WP4 — digiquiz.sql
-- Complete schema + seed data for the DigiQuiz 3-tier AWS capstone.
--
-- Target: MySQL 8.0 / MariaDB 10.6+ (Amazon RDS for MySQL, Multi-AZ)
-- Safe to run top-to-bottom on a fresh database.
-- Re-runnable: CREATE ... IF NOT EXISTS + INSERT IGNORE / ON DUPLICATE KEY
-- means running this file twice does not duplicate rows or error out.
--
-- Load it from a bastion / app-tier instance:
--   mysql -h <rds-endpoint> -u admin -p < digiquiz.sql
--
-- SECURITY NOTE: options.is_correct lives ONLY in this database and is read
-- ONLY by the private app tier. It is never selected by the quiz-read query
-- and never serialised to the browser. See WP3 app-server.js.
-- =====================================================================

CREATE DATABASE IF NOT EXISTS digiquiz
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE digiquiz;

-- ---------------------------------------------------------------------
-- 1. SCHEMA
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,          -- bcrypt, cost 10+. NEVER plaintext.
  role          VARCHAR(20)  NOT NULL DEFAULT 'student',  -- 'student' | 'admin'
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS quizzes (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(150) NOT NULL,
  description VARCHAR(500),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS questions (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  quiz_id INT NOT NULL,
  stem    VARCHAR(500) NOT NULL,
  -- Indexes are declared inline rather than as separate CREATE INDEX
  -- statements so that CREATE TABLE IF NOT EXISTS makes the whole file
  -- genuinely re-runnable. (MySQL 8 has no CREATE INDEX IF NOT EXISTS.)
  KEY idx_questions_quiz (quiz_id),
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS options (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  question_id INT NOT NULL,
  label       CHAR(1) NOT NULL,                 -- 'A' | 'B' | 'C' | 'D'
  option_text VARCHAR(300) NOT NULL,
  is_correct  BOOLEAN DEFAULT FALSE,            -- *** NEVER SENT TO THE BROWSER ***
  KEY idx_options_question (question_id),
  FOREIGN KEY (question_id) REFERENCES questions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS attempts (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  user_id  INT NOT NULL,
  quiz_id  INT NOT NULL,
  score    INT NOT NULL,
  total    INT NOT NULL,
  taken_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_attempts_user  (user_id, taken_at),   -- my-attempts lookup
  KEY idx_attempts_board (quiz_id, score),      -- leaderboard aggregation
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 2. SEED: USERS
-- ---------------------------------------------------------------------
-- !!! PLACEHOLDER BCRYPT HASHES — REPLACE BEFORE ANY REAL DEPLOYMENT !!!
-- These are valid bcrypt digests (cost 10) generated for demo passwords so
-- that the seeded accounts actually log in during the demo:
--     student_demo / Passw0rd!
--     ali          / Passw0rd!
--     admin        / Admin123!
-- They are published in this repo, therefore they are NOT secret.
-- Rotate them (or delete these rows) before the app faces real users.
--
-- Generate replacements with Node (bcryptjs, no native build needed):
--     npm i bcryptjs
--     node -e "console.log(require('bcryptjs').hashSync(process.argv[1],12))" 'YourNewPassword'
-- or with Python:
--     pip install bcrypt
--     python3 -c "import bcrypt;print(bcrypt.hashpw(b'YourNewPassword',bcrypt.gensalt(12)).decode())"
-- then:  UPDATE users SET password_hash='<new hash>' WHERE username='admin';
--
-- In normal operation users are created through POST /api/auth/register,
-- which hashes with bcrypt in the app tier. These rows exist only to make
-- the demo reproducible.

INSERT INTO users (id, username, password_hash, role) VALUES
  (1, 'student_demo', '$2b$10$g6oGz6WdZvXf7JIOsuBiSuQ6cZJ0M97JFT77RuUCgqQgV.DSLwCYG', 'student'),
  (2, 'ali',          '$2b$10$47EZl.CXB7Y.unIJRQ4jseFsG.VHeZdQq0SwCxXYitpiOoaZW1zcK', 'student'),
  (3, 'admin',        '$2b$10$BjbPHk4tmOVTFSA49r3qoubJO5tktXh2Twl/eCJ1AulVlmuU0dA2.', 'admin')
ON DUPLICATE KEY UPDATE
  password_hash = VALUES(password_hash),
  role          = VALUES(role);

-- ---------------------------------------------------------------------
-- 3. SEED: QUIZZES  (explicit IDs so the FKs below are predictable)
-- ---------------------------------------------------------------------

INSERT IGNORE INTO quizzes (id, title, description) VALUES
  (1, 'Load Balancing Basics',
      'Elastic Load Balancing types, target groups, health checks and cross-zone load balancing.'),
  (2, 'CloudWatch Monitoring',
      'Namespaces, dimensions, basic vs detailed monitoring, the unified CloudWatch agent and alarms.'),
  (3, 'Security & Encryption',
      'SSE-S3 vs SSE-KMS, encrypting existing EBS volumes and RDS instances, S3 Bucket Keys and KMS key material.');

-- ---------------------------------------------------------------------
-- 4. SEED: QUIZ 1 — Load Balancing Basics (questions 101-105)
-- ---------------------------------------------------------------------

INSERT IGNORE INTO questions (id, quiz_id, stem) VALUES
  (101, 1, 'Which Elastic Load Balancer operates at Layer 7 and can route requests using host-based and path-based rules?'),
  (102, 1, 'Your application needs to handle millions of requests per second at ultra-low latency and requires a static IP address per Availability Zone. Which load balancer should you choose?'),
  (103, 1, 'What does an Elastic Load Balancer do when a registered target starts failing its health checks?'),
  (104, 1, 'What is the effect of enabling cross-zone load balancing?'),
  (105, 1, 'In a target group health check configuration, which setting controls how many consecutive successful checks are required before an unhealthy target is considered healthy again?');

INSERT IGNORE INTO options (id, question_id, label, option_text, is_correct) VALUES
  (1011, 101, 'A', 'Classic Load Balancer (CLB)', FALSE),
  (1012, 101, 'B', 'Network Load Balancer (NLB)', FALSE),
  (1013, 101, 'C', 'Application Load Balancer (ALB)', TRUE),
  (1014, 101, 'D', 'Gateway Load Balancer (GWLB)', FALSE),

  (1021, 102, 'A', 'Application Load Balancer, because it terminates HTTPS', FALSE),
  (1022, 102, 'B', 'Network Load Balancer, because it works at Layer 4 and supports static/Elastic IPs', TRUE),
  (1023, 102, 'C', 'Classic Load Balancer, because it is the cheapest option', FALSE),
  (1024, 102, 'D', 'Gateway Load Balancer, because it scales third-party appliances', FALSE),

  (1031, 103, 'A', 'It stops sending new requests to that target and resumes only after the target passes the healthy threshold again', TRUE),
  (1032, 103, 'B', 'It immediately terminates the EC2 instance', FALSE),
  (1033, 103, 'C', 'It reboots the target and keeps routing traffic to it', FALSE),
  (1034, 103, 'D', 'It deletes the target group and recreates it', FALSE),

  (1041, 104, 'A', 'It replicates EBS volumes between Availability Zones', FALSE),
  (1042, 104, 'B', 'It distributes incoming requests evenly across all registered targets in every enabled Availability Zone, not just the targets in the zone that received the request', TRUE),
  (1043, 104, 'C', 'It copies AMIs to a second Region for disaster recovery', FALSE),
  (1044, 104, 'D', 'It enables automatic failover between AWS Regions', FALSE),

  (1051, 105, 'A', 'HealthCheckIntervalSeconds', FALSE),
  (1052, 105, 'B', 'HealthCheckTimeoutSeconds', FALSE),
  (1053, 105, 'C', 'HealthyThresholdCount', TRUE),
  (1054, 105, 'D', 'UnhealthyThresholdCount', FALSE);

-- ---------------------------------------------------------------------
-- 5. SEED: QUIZ 2 — CloudWatch Monitoring (questions 201-205)
-- ---------------------------------------------------------------------

INSERT IGNORE INTO questions (id, quiz_id, stem) VALUES
  (201, 2, 'Which CloudWatch namespace contains the metrics that EC2 publishes automatically, such as CPUUtilization?'),
  (202, 2, 'What is a CloudWatch dimension?'),
  (203, 2, 'With EC2 detailed monitoring enabled, at what interval are metrics delivered to CloudWatch?'),
  (204, 2, 'Which of the following metrics is NOT available by default and requires the unified CloudWatch agent to be installed on the instance?'),
  (205, 2, 'A CloudWatch alarm is watching a metric that has stopped reporting data points. Which alarm state does it enter?');

INSERT IGNORE INTO options (id, question_id, label, option_text, is_correct) VALUES
  (2011, 201, 'A', 'AWS/EC2', TRUE),
  (2012, 201, 'B', 'AWS/Compute', FALSE),
  (2013, 201, 'C', 'CWAgent', FALSE),
  (2014, 201, 'D', 'AWS/Instances', FALSE),

  (2021, 202, 'A', 'The retention period CloudWatch keeps a metric for', FALSE),
  (2022, 202, 'B', 'A name/value pair that is part of a metric''s identity and lets you filter it, for example InstanceId=i-0abc123', TRUE),
  (2023, 202, 'C', 'The unit a metric is measured in, such as Percent or Bytes', FALSE),
  (2024, 202, 'D', 'The number of alarms that can watch a single metric', FALSE),

  (2031, 203, 'A', 'Every 5 minutes, the same as basic monitoring', FALSE),
  (2032, 203, 'B', 'Every 1 minute', TRUE),
  (2033, 203, 'C', 'Every 15 seconds, at no extra cost', FALSE),
  (2034, 203, 'D', 'Only when an alarm changes state', FALSE),

  (2041, 204, 'A', 'CPUUtilization', FALSE),
  (2042, 204, 'B', 'NetworkIn', FALSE),
  (2043, 204, 'C', 'Memory utilisation (mem_used_percent) and disk space used', TRUE),
  (2044, 204, 'D', 'DiskReadBytes', FALSE),

  (2051, 205, 'A', 'ALARM', FALSE),
  (2052, 205, 'B', 'OK', FALSE),
  (2053, 205, 'C', 'INSUFFICIENT_DATA', TRUE),
  (2054, 205, 'D', 'PENDING', FALSE);

-- ---------------------------------------------------------------------
-- 6. SEED: QUIZ 3 — Security & Encryption (questions 301-305)
-- ---------------------------------------------------------------------

INSERT IGNORE INTO questions (id, quiz_id, stem) VALUES
  (301, 3, 'What is the main difference between SSE-S3 and SSE-KMS for encrypting S3 objects?'),
  (302, 3, 'You have an existing unencrypted EBS volume that must become encrypted. What is the supported procedure?'),
  (303, 3, 'How do you encrypt an existing unencrypted Amazon RDS database instance?'),
  (304, 3, 'What problem does the S3 Bucket Key feature solve?'),
  (305, 3, 'Which KMS key configuration allows you to supply and manage your own key material from an on-premises HSM?');

INSERT IGNORE INTO options (id, question_id, label, option_text, is_correct) VALUES
  (3011, 301, 'A', 'SSE-S3 encrypts the object but SSE-KMS does not', FALSE),
  (3012, 301, 'B', 'SSE-S3 uses keys that S3 owns and manages for you, while SSE-KMS uses a KMS key you control, with key policies and CloudTrail auditing of every key use', TRUE),
  (3013, 301, 'C', 'SSE-KMS is client-side encryption and SSE-S3 is server-side encryption', FALSE),
  (3014, 301, 'D', 'SSE-S3 requires you to send the encryption key with every request', FALSE),

  (3021, 302, 'A', 'Select the volume in the console and toggle "Encrypted" to on', FALSE),
  (3022, 302, 'B', 'Take a snapshot of the volume, copy the snapshot with encryption enabled, create a new volume from the encrypted copy, then swap it onto the instance', TRUE),
  (3023, 302, 'C', 'Attach a KMS key directly to the running volume with the AWS CLI', FALSE),
  (3024, 302, 'D', 'Existing EBS volumes can never be encrypted by any method', FALSE),

  (3031, 303, 'A', 'Enable the "Encryption" checkbox by modifying the running instance', FALSE),
  (3032, 303, 'B', 'Take a snapshot, copy the snapshot with encryption enabled, restore a new instance from the encrypted snapshot, then repoint the application', TRUE),
  (3033, 303, 'C', 'Reboot the instance with the KMS key ID as a parameter group setting', FALSE),
  (3034, 303, 'D', 'Promote a read replica; replicas are always encrypted', FALSE),

  (3041, 304, 'A', 'It stores the bucket name in an encrypted form', FALSE),
  (3042, 304, 'B', 'It reduces KMS request volume and cost by deriving a short-lived bucket-level key that encrypts many objects instead of calling KMS once per object', TRUE),
  (3043, 304, 'C', 'It lets a bucket use a different Region''s KMS key for free', FALSE),
  (3044, 304, 'D', 'It replaces bucket policies with key policies', FALSE),

  (3051, 305, 'A', 'An AWS managed key (aws/s3)', FALSE),
  (3052, 305, 'B', 'An AWS owned key', FALSE),
  (3053, 305, 'C', 'A customer managed key created with key material origin EXTERNAL, then importing your own key material', TRUE),
  (3054, 305, 'D', 'A data key generated by GenerateDataKey', FALSE);

-- ---------------------------------------------------------------------
-- 7. VERIFICATION
-- ---------------------------------------------------------------------
-- Expected output: exactly 3 rows, each with questions = 5 and options = 20.

SELECT
    q.id                          AS quiz_id,
    q.title                       AS quiz_title,
    COUNT(DISTINCT qs.id)         AS questions,
    COUNT(o.id)                   AS options,
    SUM(o.is_correct = TRUE)      AS correct_answers_defined
FROM quizzes   q
JOIN questions qs ON qs.quiz_id     = q.id
JOIN options   o  ON o.question_id  = qs.id
GROUP BY q.id, q.title
ORDER BY q.id;
