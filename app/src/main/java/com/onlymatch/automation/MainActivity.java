package com.onlymatch.automation;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public final class MainActivity extends Activity {
  private final int bg=Color.rgb(23,19,36), card=Color.rgb(39,33,55), white=Color.rgb(249,246,255), muted=Color.rgb(180,171,200), purple=Color.rgb(182,157,255);
  private LinearLayout root, eventList;
  private TextView status, totals;
  private EditText sources, endpoint, secret;
  private Switch enabled, all;
  private int dp(int n){return (int)(getResources().getDisplayMetrics().density*n+.5f);}
  private GradientDrawable shape(int color){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(15));return d;}
  private TextView text(String str,int size,int color,boolean bold){
    TextView t=new TextView(this);t.setText(str);t.setTextColor(color);t.setTextSize(size);
    if(bold)t.setTypeface(Typeface.DEFAULT,Typeface.BOLD);return t;
  }
  private void add(LinearLayout to,View v,int bottom){
    LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.bottomMargin=dp(bottom);to.addView(v,p);
  }
  private LinearLayout section(){
    LinearLayout box=new LinearLayout(this);box.setOrientation(1);box.setPadding(dp(18),dp(18),dp(18),dp(16));
    box.setBackground(shape(card));add(root,box,14);return box;
  }
  private Button action(String title, boolean primary){
    Button b=new Button(this);b.setAllCaps(false);b.setText(title);b.setTextSize(14);
    b.setTextColor(primary?bg:white);b.setBackground(shape(primary?purple:Color.rgb(72,63,95)));return b;
  }
  private EditText field(String hint,String value){
    EditText e=new EditText(this);e.setSingleLine(true);e.setTextSize(14);e.setTextColor(white);
    e.setHintTextColor(muted);e.setHint(hint);e.setText(value);e.setPadding(dp(11),dp(13),dp(11),dp(13));
    e.setBackground(shape(Color.rgb(23,20,35)));return e;
  }
  private void popup(String msg){new AlertDialog.Builder(this).setMessage(msg).setPositiveButton("OK",null).show();}
  @Override public void onCreate(Bundle b){super.onCreate(b);SyncService.periodic(this);build();}
  private void build(){
    getWindow().setStatusBarColor(bg);getWindow().setNavigationBarColor(bg);
    ScrollView scroll=new ScrollView(this);scroll.setBackgroundColor(bg);
    root=new LinearLayout(this);root.setOrientation(1);root.setPadding(dp(18),dp(28),dp(18),dp(25));
    scroll.addView(root);setContentView(scroll);
    TextView brand=text("ONLYMATCH",27,white,true);brand.setLetterSpacing(.10f);add(root,brand,1);
    add(root,text("AUTOMATION   /   ANDROID PREVIEW",11,purple,true),21);

    LinearLayout monitor=section();
    add(monitor,text("Мониторинг",19,white,true),10);
    status=text("",13,muted,false);add(monitor,status,8);
    Button permission=action("Разрешить доступ к уведомлениям",true);add(monitor,permission,10);
    permission.setOnClickListener(v->startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
    enabled=new Switch(this);enabled.setText("Включить запись");enabled.setTextColor(white);enabled.setTextSize(15);
    enabled.setChecked(Data.config(this).getBoolean("enabled",false));add(monitor,enabled,7);
    enabled.setOnCheckedChangeListener((CompoundButton c,boolean value)->{
      Data.config(this).edit().putBoolean("enabled",value).apply();refreshStatus();
    });
    add(monitor,text("Доступ включает пользователь. Система Android может ограничивать фоновую работу.",12,muted,false),0);

    LinearLayout filters=section();
    add(filters,text("Источники уведомлений",18,white,true),9);
    add(filters,text("Перечисли package name нужных приложений через запятую.",12,muted,false),9);
    sources=field("com.bank.example, com.other.app",Data.config(this).getString("sources",""));add(filters,sources,10);
    all=new Switch(this);all.setText("Все приложения — с риском приватности");all.setTextColor(white);all.setTextSize(13);
    all.setChecked(Data.config(this).getBoolean("all",false));add(filters,all,7);
    add(filters,text("Коды входа и пароли фильтруются, но фильтр не гарантирует 100% защиты. Режим «Все» только для собственного устройства.",11,muted,false),0);

    LinearLayout link=section();
    add(link,text("Передача в OnlyMatch",18,white,true),7);
    add(link,text("Для локального теста можно оставить пустым. HTTPS и токен необходимы для передачи.",12,muted,false),9);
    endpoint=field("https://domain.example/api/automation/events",Data.config(this).getString("url",""));add(link,endpoint,9);
    secret=field("Секретный ключ (не меньше 12 знаков)","");secret.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
    add(link,secret,9);
    Button save=action("Сохранить настройки",true);save.setOnClickListener(v->save());add(link,save,9);
    Button sync=action("Синхронизировать очередь",false);sync.setOnClickListener(v->{
      SyncService.request(this);popup("Запрос на синхронизацию отправлен системе Android.");
    });add(link,sync,0);

    LinearLayout journal=section();
    add(journal,text("Журнал",18,white,true),7);totals=text("",12,muted,false);add(journal,totals,10);
    Button demo=action("Создать тестовое уведомление",true);add(journal,demo,8);
    demo.setOnClickListener(v->{Data.append(this,"com.onlymatch.demo","Тестовое поступление","Зачисление +5 000 ₽ (ДЕМО)",true);SyncService.request(this);render();});
    Button reload=action("Обновить журнал",false);add(journal,reload,7);reload.setOnClickListener(v->render());
    Button clear=action("Очистить журнал",false);add(journal,clear,9);
    clear.setOnClickListener(v->new AlertDialog.Builder(this).setTitle("Удалить события?")
      .setMessage("Локальная история, включая неотправленные события, будет удалена.")
      .setNegativeButton("Отмена",null).setPositiveButton("Удалить",(d,w)->{Data.clear(this);render();}).show());
    eventList=new LinearLayout(this);eventList.setOrientation(1);add(journal,eventList,0);
    add(root,text("Тестовая версия. Банковские push-сообщения не заменяют подтверждение по выписке.",11,muted,false),0);
    refreshStatus();render();
  }
  private void save(){
    String url=endpoint.getText().toString().trim();
    String token=secret.getText().toString();
    if(!url.isEmpty()&&!url.startsWith("https://")){popup("Сервер должен использовать HTTPS.");return;}
    if(!token.isEmpty()&&token.length()<12){popup("Ключ должен содержать минимум 12 символов.");return;}
    if(all.isChecked()&&!Data.config(this).getBoolean("all",false)){
      new AlertDialog.Builder(this).setTitle("Доступ ко всем приложениям")
        .setMessage("Это может включать личную переписку и конфиденциальную информацию. Продолжить только на собственном устройстве?")
        .setNegativeButton("Отмена",null).setPositiveButton("Согласен",(d,w)->commit(url,token)).show();
    }else commit(url,token);
  }
  private void commit(String url,String token){
    try{
      if(!token.isEmpty())Data.saveToken(this,token);
      Data.config(this).edit().putString("url",url).putString("sources",sources.getText().toString().trim())
        .putBoolean("all",all.isChecked()).apply();
      SyncService.request(this);popup("Настройки сохранены.");
    }catch(Exception e){popup("Ошибка сохранения защищённого ключа.");}
  }
  private void refreshStatus(){
    if(status==null)return;
    String listeners=Settings.Secure.getString(getContentResolver(),"enabled_notification_listeners");
    boolean granted=listeners!=null&&listeners.contains(new ComponentName(this,CaptureService.class).flattenToString());
    status.setText((granted?"● Системный доступ разрешён":"○ Требуется разрешение Android")+
      "\n"+(Data.config(this).getBoolean("enabled",false)?"Запись включена":"Запись выключена"));
    status.setTextColor(granted?Color.rgb(157,233,179):muted);
  }
  @Override protected void onResume(){super.onResume();refreshStatus();render();}
  private void render(){
    if(eventList==null)return;eventList.removeAllViews();
    JSONArray a=Data.list(this);int sent=0;
    for(int i=0;i<a.length();i++){JSONObject o=a.optJSONObject(i);if(o!=null&&o.optBoolean("sent"))sent++;}
    totals.setText("Всего: "+a.length()+"   •   Отправлено: "+sent+"   •   Ожидают: "+(a.length()-sent));
    SimpleDateFormat fmt=new SimpleDateFormat("dd.MM HH:mm",new Locale("ru","RU"));
    if(a.length()==0)add(eventList,text("Пока пусто. Можно создать тестовое событие.",13,muted,false),6);
    for(int i=0;i<Math.min(a.length(),25);i++){
      JSONObject o=a.optJSONObject(i);if(o==null)continue;
      LinearLayout item=new LinearLayout(this);item.setOrientation(1);item.setPadding(dp(12),dp(13),dp(12),dp(12));item.setBackground(shape(bg));
      add(item,text((o.optBoolean("demo")?"ДЕМО · ":"")+o.optString("title"),14,white,true),4);
      add(item,text(o.optString("text"),13,white,false),5);
      add(item,text(o.optString("package")+" · "+fmt.format(new Date(o.optLong("time")))+" · "+(o.optBoolean("sent")?"ОТПРАВЛЕНО":"ЛОКАЛЬНО"),10,muted,false),0);
      add(eventList,item,8);
    }
  }
}