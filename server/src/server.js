import "./env.js";
import dns from "node:dns";
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import db, { createInterview, updateInterview, getInterview, listInterviews, clearAllInterviews, createCandidate, findUserByEmail, findUserById } from "./db.js";
import { generateQuestions, evaluateInterview } from "./ai.js";
import { getGithubSummary } from "./github.js";
import { requireAuth } from "./middleware.js";
import authRoutes from "../routes/authRoutes.js";
import resumeRoutes from "../routes/resume.js";

dns.setDefaultResultOrder("ipv4first");

const app = express();
const port = Number(process.env.PORT || 3001);
const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
const jwtSecret = process.env.JWT_SECRET || "development-only-change-me";

app.use(cors({ origin: clientUrl, credentials: true }));
app.use(express.json({limit:"4mb"}));
app.use("/api/auth", authRoutes);
app.use("/api/resume", resumeRoutes);

const emailUser = () => String(process.env.EMAIL_USER || "").trim();
const emailPass = () => String(process.env.EMAIL_PASS || "").replace(/\s+/g, "");
const emailConfigured = () => Boolean(emailUser() && emailPass());
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: emailUser(),
    pass: emailPass(),
  },
  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
});

let emailReady = false;
if (emailConfigured()) {
  transporter.verify()
    .then(() => {
      emailReady = true;
      console.log(`✅ Gmail SMTP ready: ${emailUser()}`);
    })
    .catch((e) => {
      emailReady = false;
      console.error(`❌ Gmail SMTP error: ${e.message}`);
    });
} else {
  console.log("⚠️ Gmail is not configured. Add EMAIL_USER and EMAIL_PASS to server/.env");
}

async function sendMail(options){
  if(!emailConfigured()) return {sent:false,error:"Email is not configured"};
  try{await transporter.sendMail(options);emailReady=true;return{sent:true}}catch(e){emailReady=false;console.error("❌ EMAIL SEND ERROR:",e.message);return{sent:false,error:e.message}}
}

function parseJson(value,fallback){try{return value?JSON.parse(value):fallback}catch{return fallback}}
function tokenFromReq(req){return req.headers.authorization?.startsWith("Bearer ")?req.headers.authorization.slice(7):null}
function signCandidate(candidate){return jwt.sign({id:candidate.id,email:candidate.email,role:"candidate"},jwtSecret,{expiresIn:"7d"})}

app.get("/api/health",(_,res)=>res.json({ok:true,emailConfigured:emailConfigured(),emailReady,openaiConfigured:Boolean(process.env.OPENAI_API_KEY?.trim()),database:true}));

// Candidate email OTP login
app.post("/api/auth/send-otp",async(req,res)=>{
  try{
    const email=String(req.body?.email||"").trim().toLowerCase();
    if(!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({error:"Please enter a valid email"});
    const otp=String(crypto.randomInt(100000,1000000));
    db.prepare(`INSERT INTO otp_codes(email,otp,expires_at,attempts) VALUES(?,?,?,0) ON CONFLICT(email) DO UPDATE SET otp=excluded.otp,expires_at=excluded.expires_at,attempts=0`).run(email,otp,Date.now()+5*60*1000);
    const mail=await sendMail({from:`"AI Interviewer" <${emailUser()}>`,to:email,subject:"Your AI Interviewer OTP",html:`<div style="font-family:Arial;max-width:600px;margin:auto"><h2>AI Interviewer</h2><p>Your verification code is:</p><div style="font-size:32px;font-weight:bold;letter-spacing:8px;padding:20px;background:#f4f4f4;text-align:center">${otp}</div><p>Valid for 5 minutes.</p></div>`});
    if(!mail.sent){
      db.prepare("DELETE FROM otp_codes WHERE email=?").run(email);
      return res.status(503).json({error:"OTP email could not be sent",details:mail.error});
    }
    res.json({success:true,message:"OTP sent successfully"});
  }catch(e){console.error("OTP ERROR",e);res.status(500).json({error:"Failed to send OTP",details:e.message})}
});

app.post("/api/auth/verify-otp",(req,res)=>{
  const email=String(req.body?.email||"").trim().toLowerCase();const otp=String(req.body?.otp||"").trim();
  const record=db.prepare("SELECT * FROM otp_codes WHERE email=?").get(email);
  if(!record)return res.status(400).json({error:"OTP not found. Request a new code."});
  if(Date.now()>Number(record.expires_at)){db.prepare("DELETE FROM otp_codes WHERE email=?").run(email);return res.status(400).json({error:"OTP expired. Request a new code."})}
  if(record.otp!==otp)return res.status(400).json({error:"Invalid OTP"});
  db.prepare("DELETE FROM otp_codes WHERE email=?").run(email);const user=createCandidate(email);res.json({success:true,token:signCandidate(user),user});
});

// Recruiter/admin creates an interview and sends invitation. Email failure never loses the created interview.
async function createInterviewHandler(req,res){
  try{
    const {candidateName,email,role,difficulty="Medium",duration=45,github="",jobDescription="",language="en-IN"}=req.body||{};
    const normalizedEmail = req.user?.role === "candidate"
      ? String(req.user.email || "").trim().toLowerCase()
      : String(email || "").trim().toLowerCase();
    if(!candidateName?.trim())return res.status(400).json({error:"Candidate name is required"});
    if(!/^\S+@\S+\.\S+$/.test(normalizedEmail))return res.status(400).json({error:"Valid candidate email is required"});
    if(!role?.trim())return res.status(400).json({error:"Interview role is required"});
    const githubData=await getGithubSummary(github||"");
    const questions=await generateQuestions({role,difficulty,jobDescription,githubSummary:githubData.summary,language});
    const id=crypto.randomUUID();
    createInterview({id,created_at:new Date().toISOString(),candidate_name:candidateName.trim(),candidate_email:normalizedEmail,role:role.trim(),difficulty,duration:Number(duration)||45,github:github||"",job_description:jobDescription||"",questions:JSON.stringify(questions),transcript:"[]",status:"Pre"});
    const interviewUrl=`${clientUrl}/?interview=${encodeURIComponent(id)}`;
    const mail=await sendMail({from:`"AI Interviewer" <${emailUser()}>`,to:normalizedEmail,subject:`AI Interview Invitation — ${role}`,html:`<div style="font-family:Arial;max-width:650px;margin:auto;padding:30px"><h1>AI Interviewer</h1><h2>Hello ${candidateName}</h2><p>You have been invited to complete an AI-powered interview.</p><p><b>Role:</b> ${role}<br><b>Difficulty:</b> ${difficulty}<br><b>Duration:</b> ${duration} minutes</p><p><a href="${interviewUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none">Start Interview</a></p><p>${interviewUrl}</p></div>`});
    console.log(mail.sent?`✅ Invitation sent to ${normalizedEmail}`:`⚠️ Interview created but email not sent: ${mail.error}`);
    res.json({success:true,id,email:normalizedEmail,emailSent:mail.sent,emailError:mail.sent?null:mail.error,interviewUrl,github:githubData,questions});
  }catch(e){console.error("CREATE INTERVIEW ERROR",e);res.status(500).json({success:false,error:"Could not create interview",details:e.message})}
}
app.post("/api/v1/pre-interview",requireAuth(["admin","recruiter"]),createInterviewHandler);
app.post("/api/v1/practice-interview",requireAuth(["candidate"]),createInterviewHandler);

function canAccessInterview(req,x){return req.user.role!=="candidate" || x.candidate_email?.toLowerCase()===req.user.email?.toLowerCase()}
app.get("/api/v1/interview/:id",requireAuth(["candidate","admin","recruiter"]),(req,res)=>{const x=getInterview(req.params.id);if(!x)return res.status(404).json({error:"Interview not found"});if(!canAccessInterview(req,x))return res.status(403).json({error:"You do not have access to this interview"});res.json({...x,questions:parseJson(x.questions,[]),transcript:parseJson(x.transcript,[]),feedback:parseJson(x.feedback,null)})});

app.post("/api/v1/session/user/response/:id",requireAuth(["candidate"]),(req,res)=>{const x=getInterview(req.params.id);if(!x)return res.status(404).json({error:"Interview not found"});if(!canAccessInterview(req,x))return res.status(403).json({error:"Access denied"});const transcript=parseJson(x.transcript,[]);transcript.push({type:"User",content:String(req.body?.message||""),createdAt:new Date().toISOString()});updateInterview(x.id,{transcript:JSON.stringify(transcript),status:"Live"});res.json({success:true})});
app.post("/api/v1/session/assistant/response/:id",requireAuth(["candidate"]),(req,res)=>{const x=getInterview(req.params.id);if(!x)return res.status(404).json({error:"Interview not found"});if(!canAccessInterview(req,x))return res.status(403).json({error:"Access denied"});const transcript=parseJson(x.transcript,[]);transcript.push({type:"Assistant",content:String(req.body?.message||""),createdAt:new Date().toISOString()});updateInterview(x.id,{transcript:JSON.stringify(transcript),status:"Live"});res.json({success:true})});
app.post("/api/v1/finish/:id",requireAuth(["candidate"]),async(req,res)=>{try{const x=getInterview(req.params.id);if(!x)return res.status(404).json({error:"Interview not found"});if(!canAccessInterview(req,x))return res.status(403).json({error:"Access denied"});const result=await evaluateInterview({role:x.role,transcript:parseJson(x.transcript,[])});updateInterview(x.id,{score:result.score,feedback:JSON.stringify(result),status:"Done"});res.json(result)}catch(e){console.error("FINISH ERROR",e);res.status(500).json({error:"Failed to finish interview"})}});

app.get("/api/v1/results",requireAuth(["admin","recruiter","candidate"]),(req,res)=>{const rows=req.user.role==="candidate"?db.prepare("SELECT * FROM interviews WHERE lower(candidate_email)=lower(?) ORDER BY created_at DESC").all(req.user.email):listInterviews();res.json(rows)});
app.get("/api/admin/stats",requireAuth(["admin"]),(_,res)=>{const total=db.prepare("SELECT COUNT(*) c FROM interviews").get().c;const completed=db.prepare("SELECT COUNT(*) c FROM interviews WHERE status='Done'").get().c;const avg=db.prepare("SELECT COALESCE(ROUND(AVG(score)),0) avg FROM interviews WHERE score IS NOT NULL").get().avg;const users=db.prepare("SELECT COUNT(*) c FROM users").get().c;res.json({total,completed,avg,users})});
app.delete("/api/v1/interviews/clear",requireAuth(["admin"]),(_,res)=>{clearAllInterviews();res.json({success:true,message:"History cleared"})});

// Seed admin/recruiter accounts from .env when configured.
async function seedUsers(){for(const [name,email,password,role] of [[process.env.ADMIN_NAME,process.env.ADMIN_EMAIL,process.env.ADMIN_PASSWORD,"admin"],[process.env.RECRUITER_NAME,process.env.RECRUITER_EMAIL,process.env.RECRUITER_PASSWORD,"recruiter"]]){if(!email||!password)continue;const hash=await bcrypt.hash(password,12);db.prepare(`INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,role=excluded.role`).run(name||role,email.trim().toLowerCase(),hash,role)}}
await seedUsers();

app.listen(port, "0.0.0.0", () => {
  console.log("========================================");
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📧 Email: ${emailUser() || "NOT CONFIGURED"}`);
  console.log(`🤖 OpenAI: ${process.env.OPENAI_API_KEY ? "CONFIGURED" : "NOT CONFIGURED"}`);
  console.log("========================================");
});
